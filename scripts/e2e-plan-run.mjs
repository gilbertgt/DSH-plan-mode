/**
 * Production E2E for the Plan Mode pipeline.
 *
 * The unit and integration suites each prove one stage. This lane drives the
 * real `OrchestrationService`, the real `createOrchestratorRunner`, the real
 * parallel worktree path, the real host validation runner (executing a real
 * package script through a real shell) and the real terminal report, against a
 * real Git repository, and asserts the run reaches COMPLETE with every stage
 * having actually happened.
 *
 * Two inputs cannot come from CI: a model provider (the Planner's artifact and
 * the Reviewer's verdict) and, on this host, DSH's in-process `spawn` provider.
 * Both are supplied through the explicit, restorable seams the production code
 * already exposes (`configureNativeSpawn`, `configureSdkHarnessFactory`,
 * `configureValidationShell`, `configureRoleTimeoutResolver`); every other
 * stage ??plan validation, approval handoff, ownership guards, worktree leases,
 * patch capture and compare-and-swap apply, receipt hashing and the single
 * terminal report ??is the shipping implementation.
 *
 * Usage:
 *   node --experimental-strip-types scripts/e2e-plan-run.mjs
 *   PLANX_SKIP_SDK_LANE=1   # skip the parallel-isolated lane
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OrchestrationService } from '../src/orchestration/service.ts'
import { createOrchestratorRunner } from '../src/orchestration/engine.ts'
import { configureNativeSpawn } from '../src/orchestration/native-backend.ts'
import { configureSdkHarnessFactory } from '../src/orchestration/sdk-backend.ts'
import { configureValidationShell } from '../src/validation/runner.ts'
import { configureRoleTimeoutResolver } from '../src/runtime-policy.ts'
import { DEFAULT_SETTINGS } from '../src/contract/settings.ts'
import { RunStore } from '../src/recovery/store.ts'
import { git } from '../src/git/repository.ts'
import { extractPlanArtifact } from '../src/contract/plan-artifact.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const TEST_TIMEOUT_MS = 180_000

function log(message) {
  process.stdout.write(`[e2e-plan] ${message}\n`)
}

async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** A real repository with a real package script the host validation will run. */
async function fixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'planx-e2e-'))
  await git(dir, ['init'])
  await git(dir, ['config', 'user.email', 'e2e@example.com'])
  await git(dir, ['config', 'user.name', 'e2e'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
  await writeFile(join(dir, 'b.ts'), 'export const b = 1\n')
  // Ignored, exactly as a real project keeps its installed dependencies, so the
  // validation worktree provisions them instead of finding them checked in.
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n')
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: 'planx-e2e-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { 'test:unit': 'node -e "process.stdout.write(\'PLANX_HOST_VALIDATION_RAN\')"' },
  }, null, 2)}\n`)
  await writeFile(join(dir, 'package-lock.json'), `${JSON.stringify({
    name: 'planx-e2e-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'planx-e2e-fixture', version: '1.0.0' } },
  }, null, 2)}\n`)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'fixture-dep.js'), 'export default 1\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'base'])
  return dir
}

/**
 * The plan is authored as the planner really produces it ??fenced JSON inside
 * the plan text ??so `extractPlanArtifact` performs the real validation.
 */
const PLAN_TEXT = `Deliver two independent fixture rewrites.

\`\`\`json
${JSON.stringify({
  planModeVersion: 1,
  summary: 'Rewrite the two fixture modules independently.',
  complexity: 'small',
  decisionLocks: ['Each task may change only its own file.'],
  tasks: [
    {
      id: 't1',
      title: 'Rewrite a.ts',
      objective: 'Change a.ts to the worker value.',
      read: ['a.ts'],
      modify: ['a.ts'],
      decisionLocks: [],
      requiredChanges: ['a.ts exports the worker value.'],
      acceptanceCriteria: ['a.ts contains the worker output.'],
      validation: ['Host validation runs the package script.'],
      dependsOn: [],
      parallelSafe: true,
    },
    {
      id: 't2',
      title: 'Rewrite b.ts',
      objective: 'Change b.ts to the worker value.',
      read: ['b.ts'],
      modify: ['b.ts'],
      decisionLocks: [],
      requiredChanges: ['b.ts exports the worker value.'],
      acceptanceCriteria: ['b.ts contains the worker value.'],
      validation: ['Host validation runs the package script.'],
      dependsOn: [],
      parallelSafe: true,
    },
  ],
  validationStrategy: ['Host validation runs npm run test:unit in a detached worktree.'],
  validationCommands: [{ id: 'unit', taskIds: ['t1', 't2'], command: 'npm run test:unit', timeoutMs: 60_000 }],
  risks: [],
  outOfScope: [],
}, null, 2)}
\`\`\`
`

/** The value each task's Worker writes, and the contract body it reports. */
function workerContract(taskId) {
  const path = taskId === 't2' ? 'b.ts' : 'a.ts'
  return {
    taskId,
    path,
    content: `export const ${taskId === 't2' ? 'b' : 'a'} = 2\n`,
    structured: { taskId, status: 'COMPLETE', changed: [path], validation: [], remaining: [], contextExpansion: [] },
  }
}

/** A recording agent: the parent conversation the report must reach. */
function makeAgent(cwd, sessionId) {
  const events = []
  const deliveries = { followup: [], inject: [] }
  const session = {
    id: sessionId,
    header: { cwd },
    append(type, data) { events.push({ type, data: JSON.parse(JSON.stringify(data)) }) },
    snapshotEvents() { return events },
  }
  return {
    events,
    deliveries,
    status: 'idle',
    options: { provider: 'e2e-provider', model: 'e2e-model' },
    session,
    followup(message) { deliveries.followup.push(message) },
    inject(message) { deliveries.inject.push(message) },
    runMaintenance(fn) { return Promise.resolve().then(() => fn(new AbortController().signal)) },
    async run() { return undefined },
  }
}

/** A real shell execution of the planned package script, driven by Node. */
function hostShell() {
  return {
    resolve: request => request,
    run: async request => {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      const result = await run(process.execPath, ['-e',
        `process.stdout.write('PLANX_HOST_VALIDATION_RAN')`,
      ], { cwd: request.cwd, windowsHide: true }).catch(error => ({
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? error.message),
        exitCode: typeof error.code === 'number' ? error.code : 1,
      }))
      const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout)
      const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr)
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: { text: stdout, truncated: false },
        stderr: { text: stderr, truncated: false },
        sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full', runnerFailed: false },
      }
    },
  }
}

function ctxFor(delegate) {
  const catalog = ['read', 'write', 'edit']
  return {
    llm: { resolveCallConfig: async choice => choice },
    tools: {
      schemas: () => catalog.map(name => ({ name })),
      guard: () => () => {},
    },
    on: () => () => {},
    // The Reviewer is delegated by the engine directly through the subagent
    // seam; the Worker and Integrator go through NativeSpawnBackend. Both
    // resolve to the same role handler, so one lane cannot silently diverge.
    subagents: {
      start: async (_mode, options) => delegate({
        label: String(options.label ?? 'review'),
        prompt: (Array.isArray(options.prompt) ? options.prompt : []).map(block => String(block?.text ?? '')).join('\n'),
        parent: options.parent,
        signal: options.signal,
        route: options.agentOptions ?? {},
        outputSchema: options.outputSchema,
        toolFilter: options.toolFilter,
        persona: options.persona,
      }),
    },
  }
}

async function waitForTerminal(store, sessionId, runId, label) {
  return withTimeout((async () => {
    for (;;) {
      const manifest = await store.readManifest(sessionId, runId).catch(() => undefined)
      if (manifest?.terminal) return manifest
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })(), TEST_TIMEOUT_MS, `${label} terminal manifest`)
}

/**
 * Run one plan end to end and assert the pipeline actually happened.
 *
 * @param options.parallel ??drive the isolated worktree wave instead of serial
 * @param options.failSdkLane ??make the SDK lane throw so the engine must downgrade
 */
async function runLane({ label, parallel, failSdkLane = false }) {
  const repo = await fixtureRepo()
  const stateRoot = await mkdtemp(join(tmpdir(), 'planx-e2e-state-'))
  const restoreShell = configureValidationShell(hostShell())
  const restoreTimeout = configureRoleTimeoutResolver(() => 120_000)
  const workerDelegations = []
  const reviewerDelegations = []
  /** Absolute cwd of every isolated SDK worker; must be a real lease, not the repo. */
  const sdkDelegations = []

  const restoreSdk = configureSdkHarnessFactory(async options => ({
    async run(prompt) {
      if (failSdkLane) {
        const error = new Error('dsh profile "sdk": JSON-RPC input closed\ncode: \'ERR_MODULE_NOT_FOUND\'')
        error.code = 'ERR_MODULE_NOT_FOUND'
        throw error
      }
      sdkDelegations.push(options.cwd)
      // The isolated Worker writes into its own lease cwd, then reports the
      // contract; the host captures the patch and applies it to the main tree.
      // The task identity comes from the packet, not from which files exist:
      // each task has its own lease, so both leases contain a.ts.
      const contract = workerContract(String(prompt).includes('Task ID: t2') ? 't2' : 't1')
      await writeFile(join(options.cwd, contract.path), contract.content)
      return { finalResponse: JSON.stringify(contract.structured), events: [] }
    },
    async close() {},
  }))

  const emitted = []
  let service
  const store = new RunStore(stateRoot)

  /**
   * One role handler for every delegation in this lane.
   *
   * Labels are `<role>:<taskId>[:continue]`, the same dispatch the real provider
   * performs. A Worker mutates exactly its owned path in the cwd the backend
   * handed it ??the main tree for serial, the isolated lease for a parallel wave;
   * which one it is is exactly what the assertions check. The Integrator
   * reconciles already-applied work, and the Reviewer answers the protocol.
   */
  const delegate = async request => {
    const label = String(request.label)
    // The Reviewer is labelled `review-<round>-<attempt>` by the engine, not
    // `role:taskId`, so the two label shapes are distinguished explicitly.
    const isReviewer = label.startsWith('review')
    const [role, rawId] = label.split(':')
    const taskId = String(rawId ?? '').replace(/:continue$/, '')
    if (isReviewer) {
      reviewerDelegations.push(request.label)
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: '[REVIEW:PASS]\nThe owned changes satisfy the plan and the receipts are trusted.' }],
        }),
        dispose: async () => {},
      }
    }
    workerDelegations.push(request.label)
    const contract = workerContract(taskId)
    // The Integrator reconciles already-applied work, so it changes nothing here.
    const changed = role === 'integrator' ? [] : contract.structured.changed
    if (changed.length > 0) {
      await writeFile(join(request.parent.session.header.cwd, contract.path), contract.content)
    }
    return {
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { ...contract.structured, changed },
      }),
      dispose: async () => {},
    }
  }
  const restoreNative = configureNativeSpawn(delegate)
  const settings = () => ({
    ...structuredClone(DEFAULT_SETTINGS),
    execution: {
      ...DEFAULT_SETTINGS.execution,
      maxParallelWorkers: 2,
      parallelMode: parallel ? 'worktree' : 'serial',
      keepFailedWorktrees: false,
      roleTimeoutMs: 120_000,
    },
    review: { ...DEFAULT_SETTINGS.review, maxReviewRounds: 1, protocolRetry: 1, outputCapBytes: 1024 * 1024 },
  })

  const runner = createOrchestratorRunner({
    ctx: ctxFor(delegate),
    settings,
    store,
    emit: (kind, data) => { emitted.push({ kind, data }); service.recordEvent(kind, data) },
  })
  service = new OrchestrationService(store, runner)

  try {
    const { artifact, hash } = extractPlanArtifact(PLAN_TEXT)
    const agent = makeAgent(repo, `s-${label}`)
    const runId = service.approve({ sessionId: agent.session.id, agent, artifact, planHash: hash })
    assert.equal(typeof runId, 'string', `${label}: approval must produce a run`)
    assert.equal(await service.onParentIdle(agent.session.id), true, `${label}: the approved run must start`)
    const manifest = await waitForTerminal(store, agent.session.id, runId, label)
    const view = service.list(agent.session.id).find(row => row.runId === runId)
    const failure = await readFile(join(store.runDir(agent.session.id, runId), 'failure.json'), 'utf8').catch(() => undefined)

    assert.equal(manifest.phase, 'COMPLETE', `${label}: run must complete, got ${manifest.phase}: ${view?.message ?? ''}${failure ? `\n${failure}` : ''}`)
    assert.equal(manifest.terminal, true)
    assert.deepEqual(view.activeTaskIds, [], `${label}: a completed run must not list an active task`)

    // Both tasks really ran, and both really changed their own file in the main tree.
    assert.equal(await readFile(join(repo, 'a.ts'), 'utf8'), 'export const a = 2\n', `${label}: t1's change must be in the main tree`)
    assert.equal(await readFile(join(repo, 'b.ts'), 'utf8'), 'export const b = 2\n', `${label}: t2's change must be in the main tree`)

    // Host validation really executed the planned package script.
    const runDir = store.runDir(agent.session.id, runId)
    const receiptFiles = await readdir(join(runDir, 'validation')).catch(() => [])
    assert.ok(receiptFiles.length > 0, `${label}: host validation must produce a receipt`)
    const receipt = JSON.parse(await readFile(join(runDir, 'validation', `validating-unit.receipt.json`), 'utf8'))
    assert.equal(receipt.status, 'PASS', `${label}: host validation must pass`)
    assert.equal(receipt.command, 'npm run test:unit')
    assert.equal(receipt.boundHead, manifest.baselineHead)
    const stdoutPath = join(runDir, 'validation', receipt.stdout?.file ?? '')
    if (receipt.stdout?.file) {
      const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '')
      assert.match(stdoutText, /PLANX_HOST_VALIDATION_RAN/, `${label}: the planned script must really have run`)
    }

    // The completion record and the single terminal report.
    const completion = JSON.parse(await readFile(join(runDir, 'completion.json'), 'utf8'))
    assert.equal(completion.review, 'PASS')
    assert.deepEqual([...completion.changedPaths].sort(), ['a.ts', 'b.ts'])
    assert.equal(agent.deliveries.followup.length, 1, `${label}: exactly one waking terminal report`)
    assert.equal(agent.deliveries.inject.length, 0)

    const phases = agent.events.filter(event => event.type === 'planx/run-phase').map(event => event.data.phase)
    for (const phase of ['PREFLIGHT', 'WORKERS', 'VALIDATING', 'REVIEWING', 'COMPLETE']) {
      assert.ok(phases.includes(phase), `${label}: phase ${phase} must be emitted, saw ${phases.join(' -> ')}`)
    }
    assert.ok(
      phases.indexOf('WORKERS') < phases.indexOf('VALIDATING')
      && phases.indexOf('VALIDATING') < phases.indexOf('REVIEWING')
      && phases.indexOf('REVIEWING') < phases.indexOf('COMPLETE'),
      `${label}: phases must run in pipeline order, saw ${phases.join(' -> ')}`,
    )

    // No lease survives a completed run, and no patch artifact is missing.
    const worktrees = await readFile(join(runDir, 'worktrees.json'), 'utf8').then(JSON.parse).catch(() => ({ worktrees: [] }))
    for (const record of worktrees.worktrees) {
      assert.equal(record.status, 'CLEANED', `${label}: lease ${record.taskId} must be cleaned`)
      await assert.rejects(() => stat(record.path), /ENOENT/, `${label}: lease ${record.taskId} must be removed`)
    }
    if (parallel) {
      assert.ok(worktrees.worktrees.length >= 2, `${label}: the parallel wave must have leased both tasks`)
    }

    // The SDK lane was attempted first and, when it failed, the durable record
    // still says so after the serial fallback succeeded.
    if (failSdkLane) {
      assert.ok(
        emitted.some(event => event.kind === 'phase' && /parallel SDK lane unavailable/.test(String(event.data?.message ?? ''))),
        `${label}: the fallback must be reported`,
      )
      assert.ok(workerDelegations.some(name => name.includes(':continue') || name.startsWith('worker:')), `${label}: the serial fallback must delegate`)
      assert.ok(
        agent.events.some(event => event.type === 'planx/run-phase' && /parallel SDK lane unavailable/.test(String(event.data?.message ?? ''))),
        `${label}: the SDK root cause must survive into the durable event log`,
      )
    }
    if (parallel && !failSdkLane) {
      // The isolated lane is defined by running each Worker in its own detached
      // lease: a delegation whose cwd is the main tree would mean the wave
      // silently degraded to serial and this lane proved nothing.
      assert.ok(sdkDelegations.length >= 2, `${label}: both tasks must run in the isolated SDK lane`)
      for (const cwd of sdkDelegations) {
        assert.notEqual(cwd, repo, `${label}: an isolated worker must not run in the main tree`)
      }
      assert.ok(reviewerDelegations.length >= 1, `${label}: the Reviewer must be delegated to`)
    }

    log(`${label}: COMPLETE (workers=${workerDelegations.length}, reviewers=${reviewerDelegations.length}, receipts=${receiptFiles.length})`)
    return { runId, completion, manifest }
  } finally {
    restoreSdk()
    restoreNative()
    restoreTimeout()
    restoreShell()
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function main() {
  // The packaged entry points must exist: this lane is meant to prove the
  // shipped artifact, not a source-only arrangement.
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'compatibility.json']) {
    if (!existsSync(join(root, required))) throw new Error(`build output missing: ${required} (run npm run build first)`)
  }
  await runLane({ label: 'serial', parallel: false })
  await runLane({ label: 'serial-sdk-fallback', parallel: true, failSdkLane: true })
  if (process.env.PLANX_SKIP_SDK_LANE === '1') {
    log('parallel SDK lane skipped (PLANX_SKIP_SDK_LANE=1)')
  } else {
    await runLane({ label: 'parallel-isolated', parallel: true })
  }
  log('production plan pipeline OK')
}

await main()
