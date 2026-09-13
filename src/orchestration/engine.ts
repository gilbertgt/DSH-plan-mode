import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PlanSettings, RouteChoice } from '../contract/settings.ts'
import type { PlanArtifact, PlanTask } from '../contract/plan-artifact.ts'
import type { OrchestratorLaunch } from './service.ts'
import { repoRoot, fullHead, assertRepoPathsConfined, git, decodeUtf8Strict } from '../git/repository.ts'
import { snapshotDirty, deltaPaths, snapshotHash, ownedFingerprint, type TreeSnapshot } from '../git/fingerprints.ts'
import { assertOwnedPaths } from '../git/ownership.ts'
import { createWorktree, removeOwnedWorktree, type WorktreeLease } from '../git/worktrees.ts'
import { capturePatch, type PatchArtifact } from '../git/patches.ts'
import { applyPatchArtifact, integratorPrompt, needsIntegrator } from './integrator.ts'
import { buildWaves, recheckWave, type ExecutionWave } from './scheduler.ts'
import { buildTaskPacket } from './task-packet.ts'
import { NativeSpawnBackend, type RoleExecutionResult } from './native-backend.ts'
import { SdkWorkspaceBackend, type SdkRoleExecutionResult } from './sdk-backend.ts'
import { routeChoices, preflightRoute } from './role-router.ts'
import { eligibleTransportFailure } from './failover.ts'
import { runValidation } from '../validation/runner.ts'
import { assertTrustedReceipts, receiptIndex } from '../validation/review-handoff.ts'
import { REVIEW_CONTRACT, parseReviewVerdict, type ReviewVerdict } from './reviewer.ts'
import { atomicJson, readJson, type RunStore } from '../recovery/store.ts'
import type { RecoveryCheckpoint } from '../recovery/reconcile.ts'
import { usageFromSession, type UsageSample } from '../telemetry/usage.ts'
import { aggregateUsage, softBudgetExceeded } from '../telemetry/aggregate.ts'

export interface EngineDeps {
  ctx: any
  settings: (cwd?: string) => PlanSettings
  store: RunStore
  emit?: (type: string, data: any) => void
}

type MutationResult = RoleExecutionResult | SdkRoleExecutionResult
interface WorkerOutcome { task: PlanTask; result: MutationResult; changed: string[]; patch?: PatchArtifact }
interface WorktreeRecord { taskId: string; path: string; baseHead: string; status: 'ACTIVE'|'CAPTURED'|'FAILED'|'CLEANED'; fingerprint?: string; patchSha256?: string }

const unionOwnership = (plan: PlanArtifact): string[] => [...new Set(plan.tasks.flatMap(task => task.modify))].sort()
/**
 * Absent route fields must not exist at all. An explicit `reasoningEffort:
 * undefined` is rejected by every DSH lossless-JSON boundary (subagent
 * descriptors, the session log, SDK child options), so each property is
 * constructed only when the live agent actually carries a value — including
 * provider/model, which an unresolved inherited agent legitimately lacks.
 */
export const currentRoute = (agent: any): RouteChoice => {
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  const reasoningEffort = agent?.options?.reasoningEffort
  const maxTokens = agent?.options?.maxTokens
  return {
    ...(provider !== undefined ? { provider: String(provider) } : {}),
    ...(model !== undefined ? { model: String(model) } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort: String(reasoningEffort) } : {}),
    ...(maxTokens !== undefined ? { maxTokens: Number(maxTokens) } : {}),
  } as RouteChoice
}

async function resolvedChoices(ctx: any, settings: PlanSettings, role: keyof PlanSettings['roles'], agent: any): Promise<RouteChoice[]> {
  const candidates = routeChoices(settings.roles[role], currentRoute(agent))
  const good: RouteChoice[] = []
  const failures: string[] = []
  for (const choice of candidates) {
    try { good.push(await preflightRoute(ctx.llm, choice)) }
    catch (error) { failures.push(`${choice.provider}/${choice.model}: ${(error as Error).message}`) }
  }
  if (good.length === 0) throw new Error(`no valid ${role} route${failures.length ? ` (${failures.join('; ')})` : ''}`)
  return good
}

function continuationPacket(base: string, error: unknown): string {
  return `${base}\n\nCONTINUATION AFTER PROVIDER/TRANSPORT FAILURE:\nThe previous attempt may have mutated the working tree. First inspect the actual current tree. Preserve valid existing changes, complete only remaining Plan-required work, and never reset/checkout/clean/stash or blindly replay the task. Previous failure: ${String((error as any)?.code ?? (error as Error)?.message ?? error)}`
}

/**
 * Fresh fallbacks are allowed until mutation occurs. Once any run-owned mutation
 * is observed, exactly one continuation attempt on the next route is allowed.
 */
async function runMutationRole<T extends MutationResult>(
  root: string,
  allowed: string[],
  routes: RouteChoice[],
  run: (route: RouteChoice, continuation: boolean, error?: unknown) => Promise<T>,
): Promise<T> {
  const logicalBaseline = await snapshotDirty(root)
  let lastError: unknown
  for (let index = 0; index < routes.length; index++) {
    try { return await run(routes[index]!, false, lastError) }
    catch (error) {
      lastError = error
      if (!eligibleTransportFailure(error)) throw error
      const current = await snapshotDirty(root)
      const changed = deltaPaths(logicalBaseline, current)
      assertOwnedPaths(changed, allowed)
      if (changed.length > 0) {
        if (index + 1 >= routes.length) throw error
        // Post-mutation: one and only one continuation attempt.
        return run(routes[index + 1]!, true, error)
      }
      if (index + 1 >= routes.length) throw error
      // Pre-mutation: continue through the configured fallback chain.
    }
  }
  throw lastError
}

async function updateCheckpoint(
  store: RunStore,
  launch: OrchestratorLaunch,
  runId: string,
  root: string,
  head: string,
  ownership: string[],
  phase: string,
  options: { role?: string; completedTaskIds?: string[]; safeBoundary?: boolean } = {},
): Promise<RecoveryCheckpoint> {
  const snapshot = await snapshotDirty(root)
  const checkpoint: RecoveryCheckpoint = {
    schemaVersion: 1,
    head,
    ownership: [...ownership].sort(),
    changedPaths: Object.keys(snapshot.paths).sort(),
    fingerprint: snapshotHash(snapshot),
    phase,
    role: options.role,
    completedTaskIds: options.completedTaskIds ?? [],
    safeBoundary: options.safeBoundary ?? false,
    at: new Date().toISOString(),
  }
  const dir = store.runDir(launch.sessionId, runId)
  await atomicJson(join(dir, 'recovery.json'), checkpoint)
  const manifest = await store.readManifest(launch.sessionId, runId)
  manifest.phase = phase
  manifest.repoRoot = root
  manifest.baselineHead = head
  manifest.ownership = [...ownership].sort()
  manifest.completedTaskIds = checkpoint.completedTaskIds
  await store.writeManifest(manifest)
  return checkpoint
}

async function writeWorktreeManifest(runDir: string, records: WorktreeRecord[]): Promise<void> {
  await atomicJson(join(runDir, 'worktrees.json'), { schemaVersion: 1, worktrees: records })
}

function dirtyOwnershipConflict(runBaseline: TreeSnapshot, tasks: PlanTask[]): boolean {
  const dirty = new Set(Object.keys(runBaseline.paths))
  return tasks.some(task => task.modify.some(path => dirty.has(path)))
}

async function boundedTextDiff(root: string, paths: string[], preExisting: string[], capBytes = 256 * 1024): Promise<string> {
  const cleanPaths = paths.filter(path => !preExisting.includes(path))
  const dirtyPaths = paths.filter(path => preExisting.includes(path))
  let text = ''
  if (cleanPaths.length > 0) {
    const result = await git(root, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', ...cleanPaths], { maxBuffer: capBytes * 2 })
    const raw = decodeUtf8Strict(result.stdout)
    text += raw.length > capBytes ? `${raw.slice(0, capBytes)}\n[diff truncated by host]\n` : raw
  }
  if (dirtyPaths.length > 0) {
    text += `\nPre-existing dirty paths changed during this run; HEAD diff is not a clean attribution for these paths. Inspect current contents and the host fingerprints instead:\n${dirtyPaths.map(path => `- ${path}`).join('\n')}\n`
  }
  return text || '(no textual diff; binary/new/deleted paths may still be present)'
}

function reviewerPrompt(plan: PlanArtifact, changed: string[], preExisting: string[], receipts: any[], actualDiff: string): string {
  return `${REVIEW_CONTRACT}\n\nAuthoritative PlanArtifact:\n${JSON.stringify(plan, null, 2)}\n\nRun-owned changed paths:\n${changed.map(path => `- ${path}`).join('\n') || '- none'}\n\nPre-existing dirty paths (not attributable to this run unless their fingerprint changed after the run baseline):\n${preExisting.map(path => `- ${path}`).join('\n') || '- none'}\n\nHost-observed actual diff/evidence:\n${actualDiff}\n\nTrusted validation receipt index:\n${JSON.stringify(receipts, null, 2)}\n\nUse read-only tools only when additional current-file evidence is necessary.`
}

async function nativeReviewer(
  ctx: any,
  parent: any,
  prompt: string,
  routes: RouteChoice[],
  signal: AbortSignal,
  label: string,
): Promise<{ text: string; usage: UsageSample }> {
  let last: unknown
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index]!
    const started = Date.now()
    try {
      const run = await ctx.subagents.start('spawn', {
        label: `${label}-${index}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal,
        agentOptions: route,
        maxDepth: 1,
        // Allow-list instead of deny-list: unknown third-party mutation tools do
        // not become visible merely because we failed to name them.
        toolFilter: { allow: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch'] },
        persona: 'Independent Reviewer. Strictly read-only. Review host evidence and current files; never mutate repository or external state.',
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') {
          const error = new Error(`${label} stopped: ${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}`)
          ;(error as any).code = result.stopReason
          throw error
        }
        const text = result.output.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
        const usage = run.localAgent
          ? usageFromSession(ctx, 'reviewer', run.localAgent, route)
          : { role: 'reviewer', provider: route.provider, model: route.model, source: 'unavailable' as const }
        usage.durationMs = Date.now() - started
        return { text, usage }
      } finally {
        await run.dispose()
      }
    } catch (error) {
      last = error
      if (!eligibleTransportFailure(error) || index === routes.length - 1) throw error
    }
  }
  throw last
}

async function validateIsolated(
  root: string,
  head: string,
  leaseId: string,
  runDir: string,
  runId: string,
  changed: string[],
  plan: PlanArtifact,
  settings: PlanSettings,
  store: RunStore,
  phase: string,
  emit?: (type: string, data: any) => void,
): Promise<any[]> {
  if (plan.validationCommands.length === 0) return []
  const fingerprint = await ownedFingerprint(root, changed)
  const patch = await capturePatch(root, head, '__validation__', changed)
  const lease = await createWorktree(root, leaseId, '__validation__', head, store.root)
  let clean = false
  try {
    await applyPatchArtifact(lease.path, patch, changed)
    const receipts: any[] = []
    for (const command of plan.validationCommands) {
      const receipt = await runValidation({
        cwd: lease.path,
        runDir,
        runId,
        phase,
        commandId: command.id,
        command: command.command,
        timeoutMs: command.timeoutMs,
        capBytes: Math.min(settings.review.outputCapBytes, 16 * 1024 * 1024),
        ownershipFingerprint: fingerprint,
      })
      receipts.push(receipt)
      await atomicJson(join(runDir, 'validation', `${phase.toLowerCase()}-${command.id}.receipt.json`), receipt)
      emit?.('validation', { runId, commandId: command.id, status: receipt.status })
      if (receipt.status !== 'PASS') throw new Error(`${phase.toLowerCase()} validation ${command.id}: ${receipt.status}`)
    }
    await assertTrustedReceipts(receipts, head, fingerprint)
    clean = true
    return receipts
  } finally {
    if (clean || !settings.execution.keepFailedWorktrees) await removeOwnedWorktree(root, lease, true).catch(() => {})
  }
}

async function executeSerialTask(
  deps: EngineDeps,
  launch: OrchestratorLaunch,
  task: PlanTask,
  plan: PlanArtifact,
  root: string,
  workerRoutes: RouteChoice[],
  signal: AbortSignal,
  handoffs: string[],
  usage: UsageSample[],
): Promise<WorkerOutcome> {
  deps.emit?.('task-start', { runId: (launch as any).__runId, taskId: task.id })
  const before = await snapshotDirty(root)
  const basePacket = buildTaskPacket(plan, task, handoffs)
  const backend = new NativeSpawnBackend(deps.ctx)
  const result = await runMutationRole(root, task.modify, workerRoutes, (route, continuation, error) => backend.run({
    parent: launch.agent,
    role: 'worker',
    taskId: task.id,
    prompt: continuation ? continuationPacket(basePacket, error) : basePacket,
    route,
    signal,
    persona: 'Fresh Worker. Implement only the assigned Plan task and exact modify ownership. Never commit, push, reset, clean, stash, or discard user work.',
    ownership: { root, paths: task.modify },
  }))
  if (result.status !== 'COMPLETE') throw new Error(`worker ${task.id}: ${result.status}`)
  if (result.__usage) usage.push(result.__usage)
  const changed = deltaPaths(before, await snapshotDirty(root))
  assertOwnedPaths(changed, task.modify)
  return { task, result, changed }
}

async function executeWorktreeTask(
  deps: EngineDeps,
  launch: OrchestratorLaunch,
  runId: string,
  leaseRunId: string,
  runDir: string,
  root: string,
  head: string,
  task: PlanTask,
  plan: PlanArtifact,
  workerRoutes: RouteChoice[],
  signal: AbortSignal,
  handoffs: string[],
  usage: UsageSample[],
  records: WorktreeRecord[],
  seedPatch: PatchArtifact | undefined,
): Promise<WorkerOutcome> {
  deps.emit?.('task-start', { runId, taskId: task.id })
  const lease = await createWorktree(root, leaseRunId, task.id, head, deps.store.root)
  const record: WorktreeRecord = { taskId: task.id, path: lease.path, baseHead: head, status: 'ACTIVE' }
  records.push(record)
  await writeWorktreeManifest(runDir, records)
  let accepted = false
  try {
    if (seedPatch) await applyPatchArtifact(lease.path, seedPatch, seedPatch.files.map(file => file.path))
    const before = await snapshotDirty(lease.path)
    const basePacket = `${buildTaskPacket(plan, task, handoffs)}\n\nIMPORTANT: return exactly one JSON object matching the completion contract, with no markdown fence or prose.`
    const backend = new SdkWorkspaceBackend()
    const result = await runMutationRole(lease.path, task.modify, workerRoutes, (route, continuation, error) => backend.run({
      cwd: lease.path,
      profile: deps.settings(root).execution.sdkProfile,
      taskId: task.id,
      prompt: continuation ? continuationPacket(basePacket, error) : basePacket,
      route,
      signal,
    }))
    if (result.status !== 'COMPLETE') throw new Error(`worker ${task.id}: ${result.status}`)
    if (result.__usage) usage.push(result.__usage)
    const after = await snapshotDirty(lease.path)
    const changed = deltaPaths(before, after)
    assertOwnedPaths(changed, task.modify)
    const patch = await capturePatch(lease.path, head, task.id, changed)
    await atomicJson(join(runDir, 'patches', `${task.id}.json`), patch)
    record.status = 'CAPTURED'
    record.fingerprint = snapshotHash(after)
    record.patchSha256 = patch.sha256
    await writeWorktreeManifest(runDir, records)
    accepted = true
    return { task, result, changed, patch }
  } catch (error) {
    record.status = 'FAILED'
    await writeWorktreeManifest(runDir, records).catch(() => {})
    throw error
  } finally {
    if (accepted || !deps.settings(root).execution.keepFailedWorktrees) {
      await removeOwnedWorktree(root, lease, true).catch(() => {})
      record.status = 'CLEANED'
      await writeWorktreeManifest(runDir, records).catch(() => {})
    }
  }
}

function normalizeWaveForResume(wave: ExecutionWave, completed: Set<string>): ExecutionWave | undefined {
  const taskIds = wave.taskIds.filter(id => !completed.has(id))
  if (taskIds.length === 0) return undefined
  return taskIds.length === 1 ? { mode: 'serial', taskIds } : { ...wave, taskIds }
}

export function createOrchestratorRunner(deps: EngineDeps) {
  return async (launch: OrchestratorLaunch, runId: string, signal: AbortSignal): Promise<void> => {
    ;(launch as any).__runId = runId
    const { ctx, store } = deps
    const plan = launch.artifact
    const root = await repoRoot(launch.agent.session.header?.cwd ?? process.cwd())
    const settings = deps.settings(root)
    const head = await fullHead(root)
    if (launch.baselineHead && launch.baselineHead !== head) throw new Error(`approved baseline HEAD drift: ${launch.baselineHead} -> ${head}`)

    const allOwned = unionOwnership(plan)
    await assertRepoPathsConfined(root, allOwned)
    const runDir = store.runDir(launch.sessionId, runId)
    await mkdir(join(runDir, 'patches'), { recursive: true })
    const baselinePath = join(runDir, 'baseline.json')
    let runBaseline: TreeSnapshot
    if (launch.resumeFrom) runBaseline = await readJson<TreeSnapshot>(baselinePath)
    else {
      runBaseline = await snapshotDirty(root)
      await atomicJson(baselinePath, runBaseline)
      await updateCheckpoint(store, launch, runId, root, head, allOwned, 'PREFLIGHT', { safeBoundary: true, completedTaskIds: [] })
    }

    const workerRoutes = await resolvedChoices(ctx, settings, 'worker', launch.agent)
    const handoffPath = join(runDir, 'handoffs.json')
    const handoffs = launch.resumeFrom ? await readJson<string[]>(handoffPath).catch(() => []) : []
    const usage: UsageSample[] = []
    const worktreeRecords = await readJson<{ worktrees: WorktreeRecord[] }>(join(runDir, 'worktrees.json')).then(v => v.worktrees).catch(() => [])
    const completed = new Set(launch.completedTaskIds ?? [])
    let hadWorktree = worktreeRecords.some(record => record.status === 'CAPTURED' || record.status === 'CLEANED')

    if (launch.resumeFrom !== 'VALIDATING') {
      deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'WORKERS' })
      const configuredWaves = buildWaves(plan, settings.execution.maxParallelWorkers, settings.execution.parallelMode)
      const leaseRunId = `${runId}-worktrees`

      for (const configured of configuredWaves) {
        const wave = normalizeWaveForResume(configured, completed)
        if (!wave) continue
        signal.throwIfAborted()
        const waveTasks = wave.taskIds.map(id => plan.tasks.find(task => task.id === id)!)
        const canParallel = wave.mode === 'parallel'
          && recheckWave(plan, wave)
          && !dirtyOwnershipConflict(runBaseline, waveTasks)

        if (!canParallel) {
          // Runtime safety failures downgrade to serial rather than failing the run.
          for (const task of waveTasks) {
            const outcome = await executeSerialTask(deps, launch, task, plan, root, workerRoutes, signal, handoffs, usage)
            handoffs.push(`${task.id}: host-observed=${outcome.changed.join(',') || '(none)'} status=${outcome.result.status}`)
            completed.add(task.id)
            deps.emit?.('task-end', { runId, taskId: task.id, status: outcome.result.status })
            await atomicJson(handoffPath, handoffs)
            await updateCheckpoint(store, launch, runId, root, head, allOwned, 'WORKERS', { completedTaskIds: [...completed], safeBoundary: true })
          }
          continue
        }

        hadWorktree = true
        const mainBefore = await snapshotDirty(root)
        if (mainBefore.head !== head) throw new Error('HEAD drift before parallel wave')
        const priorRunDelta = deltaPaths(runBaseline, mainBefore)
        assertOwnedPaths(priorRunDelta, allOwned)
        const seedPatch = priorRunDelta.length > 0 ? await capturePatch(root, head, '__wave_seed__', priorRunDelta) : undefined
        const outcomes = await Promise.all(waveTasks.map(task => executeWorktreeTask(
          deps, launch, runId, leaseRunId, runDir, root, head, task, plan,
          workerRoutes, signal, handoffs, usage, worktreeRecords, seedPatch,
        )))

        const mainAfterWorkers = await snapshotDirty(root)
        if (snapshotHash(mainAfterWorkers) !== snapshotHash(mainBefore)) {
          throw new Error('working tree drift while parallel workers were isolated; refusing to apply patches')
        }
        if (await fullHead(root) !== head) throw new Error('HEAD drift before applying parallel worker patches')

        for (const outcome of outcomes) {
          if (!outcome.patch) throw new Error(`missing patch artifact for ${outcome.task.id}`)
          await applyPatchArtifact(root, outcome.patch, allOwned)
          handoffs.push(`${outcome.task.id}: host-observed=${outcome.changed.join(',') || '(none)'} status=${outcome.result.status}`)
          completed.add(outcome.task.id)
          deps.emit?.('task-end', { runId, taskId: outcome.task.id, status: outcome.result.status })
        }
        await atomicJson(handoffPath, handoffs)
        await updateCheckpoint(store, launch, runId, root, head, allOwned, 'WORKERS', { completedTaskIds: [...completed], safeBoundary: true })
      }

      if (completed.size !== plan.tasks.length) throw new Error(`worker stage incomplete: ${completed.size}/${plan.tasks.length}`)

      if (needsIntegrator(plan.tasks.length, hadWorktree, plan.tasks.length > 1, false)) {
        deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'INTEGRATING' })
        const integratorBefore = await snapshotDirty(root)
        const routes = await resolvedChoices(ctx, settings, 'integrator', launch.agent)
        const backend = new NativeSpawnBackend(ctx)
        const basePrompt = integratorPrompt(JSON.stringify(plan), handoffs, hadWorktree ? [join(runDir, 'patches')] : [])
        const result = await runMutationRole(root, allOwned, routes, (route, continuation, error) => backend.run({
          parent: launch.agent,
          role: 'integrator',
          taskId: '__integrator__',
          prompt: continuation ? continuationPacket(basePrompt, error) : basePrompt,
          route,
          signal,
          persona: 'Integrator. Reconcile only Plan-required cross-task wiring. Never redesign, commit, push, reset, clean, stash, or touch files outside union ownership.',
          ownership: { root, paths: allOwned },
        }))
        if (result.status !== 'COMPLETE') throw new Error(`integrator: ${result.status}`)
        if (result.__usage) usage.push(result.__usage)
        assertOwnedPaths(deltaPaths(integratorBefore, await snapshotDirty(root)), allOwned)
      }

      const afterMutation = await snapshotDirty(root)
      const ownedDelta = deltaPaths(runBaseline, afterMutation)
      assertOwnedPaths(ownedDelta, allOwned)
      await updateCheckpoint(store, launch, runId, root, head, allOwned, 'VALIDATING', { completedTaskIds: [...completed], safeBoundary: true })
    }

    let finalSnapshot = await snapshotDirty(root)
    let runDelta = deltaPaths(runBaseline, finalSnapshot)
    assertOwnedPaths(runDelta, allOwned)
    deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'VALIDATING' })
    let receipts = await validateIsolated(root, head, `${runId}-validation-${Date.now()}`, runDir, runId, runDelta, plan, settings, store, 'VALIDATING', deps.emit)
    await updateCheckpoint(store, launch, runId, root, head, allOwned, 'REVIEWING', { completedTaskIds: [...completed], safeBoundary: true })

    deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'REVIEWING' })
    const reviewRoutes = await resolvedChoices(ctx, settings, 'reviewer', launch.agent)
    const preExisting = Object.keys(runBaseline.paths).sort()
    let fixRound = 0

    while (true) {
      finalSnapshot = await snapshotDirty(root)
      runDelta = deltaPaths(runBaseline, finalSnapshot)
      assertOwnedPaths(runDelta, allOwned)
      const fingerprint = await ownedFingerprint(root, runDelta)
      await assertTrustedReceipts(receipts, head, fingerprint)
      const actualDiff = await boundedTextDiff(root, runDelta, preExisting)
      const prompt = reviewerPrompt(plan, runDelta, preExisting, receiptIndex(receipts), actualDiff)

      let reviewerText = ''
      let verdict: ReviewVerdict = { kind: 'PROTOCOL_INVALID', detail: '' }
      for (let protocolAttempt = 0; protocolAttempt <= settings.review.protocolRetry; protocolAttempt++) {
        const reviewed = await nativeReviewer(ctx, launch.agent, prompt, reviewRoutes, signal, `review-${fixRound}-${protocolAttempt}`)
        reviewerText = reviewed.text
        usage.push(reviewed.usage)
        verdict = parseReviewVerdict(reviewerText)
        if (verdict.kind !== 'PROTOCOL_INVALID') break
      }
      if (verdict.kind === 'PROTOCOL_INVALID') throw new Error('Reviewer protocol invalid after retry')

      deps.emit?.('review', { runId, round: fixRound, verdict: verdict.kind })
      await atomicJson(join(runDir, `review-${fixRound}.json`), { verdict, reviewerText })
      if (verdict.kind === 'PASS') break
      if (fixRound >= settings.review.maxReviewRounds) throw new Error('Reviewer failed after maxReviewRounds')

      fixRound += 1
      deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'FIXING', reviewRound: fixRound })
      const fixBefore = await snapshotDirty(root)
      const backend = new NativeSpawnBackend(ctx)
      const basePrompt = `Targeted fix only. Reviewer findings:\n${verdict.detail}\n\nAuthoritative PlanArtifact:\n${JSON.stringify(plan)}\n\nYou may modify only these paths:\n${allOwned.join('\n')}\nDo not redesign, expand scope, commit, push, reset, clean, stash, or discard user work.`
      const result = await runMutationRole(root, allOwned, workerRoutes, (route, continuation, error) => backend.run({
        parent: launch.agent,
        role: 'worker',
        taskId: `__fix_${fixRound}__`,
        prompt: continuation ? continuationPacket(basePrompt, error) : basePrompt,
        route,
        signal,
        persona: 'Targeted fix Worker. Fix only Reviewer-identified Plan-required defects.',
        ownership: { root, paths: allOwned },
      }))
      if (result.status !== 'COMPLETE') throw new Error(`targeted fix: ${result.status}`)
      if (result.__usage) usage.push(result.__usage)
      assertOwnedPaths(deltaPaths(fixBefore, await snapshotDirty(root)), allOwned)

      finalSnapshot = await snapshotDirty(root)
      runDelta = deltaPaths(runBaseline, finalSnapshot)
      assertOwnedPaths(runDelta, allOwned)
      deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'VALIDATING', reviewRound: fixRound })
      receipts = await validateIsolated(root, head, `${runId}-fix-${fixRound}-${Date.now()}`, runDir, runId, runDelta, plan, settings, store, 'FIXING', deps.emit)
      await updateCheckpoint(store, launch, runId, root, head, allOwned, 'REVIEWING', { completedTaskIds: [...completed], safeBoundary: true })
    }

    finalSnapshot = await snapshotDirty(root)
    const finalDelta = deltaPaths(runBaseline, finalSnapshot)
    assertOwnedPaths(finalDelta, allOwned)
    const finalFingerprint = await ownedFingerprint(root, finalDelta)
    await assertTrustedReceipts(receipts, head, finalFingerprint)
    const usageSummary = aggregateUsage(usage)
    await atomicJson(join(runDir, 'telemetry.json'), usageSummary)

    if (launch.externalIssue?.publishAfterPass) {
      const { publishExternalRun } = await import('../external/publication.ts')
      await publishExternalRun({
        cwd: root,
        runDir,
        meta: launch.externalIssue,
        ownedPaths: finalDelta,
        expectedHead: head,
        expectedOwnershipFingerprint: finalFingerprint,
        receipts,
      })
    }

    deps.emit?.('phase', { runId, sessionId: launch.sessionId, phase: 'COMPLETE' })
    await atomicJson(join(runDir, 'completion.json'), {
      runId,
      planHash: launch.planHash,
      review: 'PASS',
      changedPaths: finalDelta,
      ownershipFingerprint: finalFingerprint,
      receipts: receiptIndex(receipts),
      usage: usageSummary,
      completedAt: new Date().toISOString(),
    })

    try {
      launch.agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `Plan Orchestrator completed run ${runId}. Reviewer: PASS. Changed paths: ${finalDelta.join(', ') || '(none)'}. Validation: ${receipts.map((receipt: any) => `${receipt.commandId}=${receipt.status}`).join(', ') || 'no host commands'}.`,
        }],
        source: { kind: 'plugin', plugin: 'plan-orchestrator' },
      }))
    } catch {}
  }
}
