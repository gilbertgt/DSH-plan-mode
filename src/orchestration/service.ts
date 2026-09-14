import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PlanArtifact } from '../contract/plan-artifact.ts'
import { reducePlanxEvents, assertNoUndefinedEventData, type RunPhase, type RunProjection } from '../contract/events.ts'
import { RunStore, atomicJson, readJson, type RunManifest } from '../recovery/store.ts'
import { diagnoseResume, interruptManifest, type RecoveryCheckpoint } from '../recovery/reconcile.ts'
import { repoRoot } from '../git/repository.ts'
import { cleanupRunWorktrees } from '../git/worktrees.ts'
import { deliverTerminalReport, terminalReportText, type TerminalPhase } from './report.ts'

export interface ExternalRunMeta {
  issueNumber: number
  repository: string
  revision: number
  branch: string
  publishAfterPass: boolean
}

export interface OrchestratorLaunch {
  sessionId: string
  agent: any
  artifact: PlanArtifact
  planHash: string
  baselineHead?: string
  resumeFrom?: 'PREFLIGHT'|'WORKERS'|'VALIDATING'
  completedTaskIds?: string[]
  externalIssue?: ExternalRunMeta
}

export interface RunView extends RunProjection {
  review?: unknown
  receipts?: unknown
  usage?: unknown
  changedPaths?: string[]
  failure?: { phase: string; message?: string; cause?: { code?: string; message: string; chain: string[] } }
}

interface Pending { runId: string; launch: OrchestratorLaunch; persisted: Promise<void>; cancelled: boolean }

type OrchestratorRunner = (launch: OrchestratorLaunch, runId: string, signal: AbortSignal) => Promise<void>

const TERMINAL_PHASES = new Set<string>(['COMPLETE', 'BLOCKED', 'FAILED', 'INTERRUPTED', 'CANCELLED'])
const TERMINALS: readonly TerminalPhase[] = ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED']
/** Runner errors matching this shape are safety boundaries, not plain faults. */
const BLOCKING_FAILURE = /(drift|ownership|blocked|inconclusive|unsafe|conflict|escape|checkpoint|tampered|stale)/i

/**
 * A failure the orchestrator itself declared a safety boundary.
 *
 * The persisted `code` is the primary classifier: a plain provider or filesystem
 * fault whose message merely happens to contain a word like "conflict" or
 * "server" must stay FAILED rather than being promoted to BLOCKED, so the regex
 * survives only as a fallback for errors thrown before the typed boundary.
 */
export class OrchestrationBlockedError extends Error {
  readonly code = 'BLOCKED_BOUNDARY'
  constructor(message: string) {
    super(message)
    this.name = 'OrchestrationBlockedError'
  }
}

function isTerminalPhase(phase: string): phase is TerminalPhase {
  return (TERMINALS as readonly string[]).includes(phase)
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  try {
    const encoded = JSON.stringify(error)
    if (encoded && encoded !== '{}' && encoded !== 'null') return encoded
  } catch { /* fall through to the generic label */ }
  return 'unknown orchestration failure'
}

/** Bounded `cause` chain, outermost first, so a wrapped root cause survives. */
function failureChain(error: unknown): string[] {
  const chain: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const next = current instanceof Error ? current.cause : undefined
    chain.push(failureMessage(current))
    if (next === current) break
    current = next
  }
  return [...new Set(chain)]
}

function failureCode(error: unknown): string | undefined {
  const code = (error as any)?.code
  return typeof code === 'string' && code.length > 0 && code.length <= 80 ? code : undefined
}

function terminalPhaseFor(aborted: boolean, message: string, code?: string): 'CANCELLED'|'BLOCKED'|'FAILED' {
  if (aborted) return 'CANCELLED'
  if (code === 'BLOCKED_BOUNDARY') return 'BLOCKED'
  return BLOCKING_FAILURE.test(message) ? 'BLOCKED' : 'FAILED'
}

export class OrchestrationService {
  readonly store: RunStore
  readonly runner: OrchestratorRunner
  #active = new Map<string, Promise<void>>()
  #activeRun = new Map<string, string>()
  #pending = new Map<string, Pending>()
  #controllers = new Map<string, AbortController>()
  #views = new Map<string, RunView>()
  #agents = new Map<string, any>()
  /**
   * Identifiers whose terminal report already reached the parent conversation.
   *
   * `finalize` is the single delivery point and is reachable more than once for
   * one run (a resume that fails to start, a cancel racing the launch), so the
   * conversation must not receive the same outcome twice.
   */
  #reported = new Set<string>()

  constructor(store: RunStore, runner: OrchestratorRunner) {
    this.store = store
    this.runner = runner
  }

  approve(launch: OrchestratorLaunch): string | false {
    if (this.#pending.has(launch.sessionId) || this.#active.has(launch.sessionId)) return false
    const runId = randomUUID()
    const now = new Date().toISOString()
    const view: RunView = {
      runId,
      sessionId: launch.sessionId,
      phase: 'APPROVED_PENDING',
      status: 'APPROVED_PENDING',
      tasksTotal: launch.artifact.tasks.length,
      tasksDone: 0,
      activeTaskIds: [],
      reviewRound: 0,
      startedAt: now,
      updatedAt: now,
    }
    this.#views.set(runId, view)
    this.#agents.set(launch.sessionId, launch.agent)
    this.append(launch.agent.session, 'planx/run-approved', {
      runId,
      sessionId: launch.sessionId,
      planHash: launch.planHash,
      tasksTotal: launch.artifact.tasks.length,
      at: now,
    })
    const persisted = this.persistApproval(launch, runId, now)
    this.#pending.set(launch.sessionId, { runId, launch, persisted, cancelled: false })
    if (launch.agent.status === 'idle') queueMicrotask(() => void this.onParentIdle(launch.sessionId))
    return runId
  }

  shouldFence(sessionId: string): boolean { return this.#pending.has(sessionId) }
  activeRun(sessionId: string): string | undefined { return this.#pending.get(sessionId)?.runId ?? this.#activeRun.get(sessionId) }

  list(sessionId?: string): RunView[] {
    return [...this.#views.values()]
      .filter(view => !sessionId || view.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async detail(runId: string): Promise<any> {
    const view = this.#views.get(runId)
    if (!view) return undefined
    const dir = this.store.runDir(view.sessionId, runId)
    const [completion, telemetry, worktrees, checkpoint, failure] = await Promise.all([
      readJson<any>(join(dir, 'completion.json')).catch(() => undefined),
      readJson<any>(join(dir, 'telemetry.json')).catch(() => undefined),
      readJson<any>(join(dir, 'worktrees.json')).catch(() => undefined),
      readJson<any>(join(dir, 'recovery.json')).catch(() => undefined),
      readJson<any>(join(dir, 'failure.json')).catch(() => undefined),
    ])
    const latestReview = await this.latestReview(dir, view.reviewRound)
    return {
      ...view,
      ...completion,
      usage: completion?.usage ?? telemetry,
      review: latestReview?.verdict ?? completion?.review,
      worktrees: worktrees?.worktrees ?? [],
      ...(failure ? { failure } : {}),
      recovery: checkpoint ? { phase: checkpoint.phase, safeBoundary: checkpoint.safeBoundary, completedTaskIds: checkpoint.completedTaskIds } : undefined,
    }
  }

  recordEvent(kind: string, data: any): void {
    const runId = String(data.runId ?? '')
    const view = this.#views.get(runId)
    if (!view) return
    const now = new Date().toISOString()
    const session = this.#agents.get(view.sessionId)?.session
    if (kind === 'phase') {
      view.phase = String(data.phase) as RunPhase
      view.status = view.phase
      view.reviewRound = Number(data.reviewRound ?? view.reviewRound)
      if (data.message) view.message = String(data.message)
      // A terminal phase ends every task. Leaving an entry behind would show a
      // finished run as still working, which is exactly what the FAILED run
      // 4429470e reported after its parallel wave failed mid-flight.
      if (TERMINAL_PHASES.has(view.phase)) view.activeTaskIds = []
      this.append(session, 'planx/run-phase', {
        runId,
        phase: view.phase,
        // Absent, never `undefined`: Session.append rejects an explicitly
        // undefined property, and a phase event with no message is normal.
        ...(data.message !== undefined ? { message: String(data.message) } : {}),
        reviewRound: view.reviewRound,
        at: now,
      })
    } else if (kind === 'task-start') {
      if (!view.activeTaskIds.includes(data.taskId)) view.activeTaskIds.push(data.taskId)
      this.append(session, 'planx/task-start', { runId, taskId: String(data.taskId), at: now })
    } else if (kind === 'task-end') {
      view.activeTaskIds = view.activeTaskIds.filter(id => id !== data.taskId)
      view.tasksDone = Math.min(view.tasksTotal, view.tasksDone + 1)
      this.append(session, 'planx/task-end', { runId, taskId: String(data.taskId), status: String(data.status ?? ''), at: now })
    } else if (kind === 'validation') {
      this.append(session, 'planx/validation', { runId, commandId: String(data.commandId), status: String(data.status), at: now })
    } else if (kind === 'review') {
      view.reviewRound = Number(data.round ?? view.reviewRound)
      this.append(session, 'planx/review', { runId, round: view.reviewRound, verdict: String(data.verdict), at: now })
    }
    view.updatedAt = now
  }

  async cancel(runId: string, reason = 'user requested stop'): Promise<boolean> {
    const view = this.#views.get(runId)
    if (!view) return false
    const sessionId = view.sessionId
    const pending = this.#pending.get(sessionId)
    if (pending?.runId === runId) {
      pending.cancelled = true
      let persistError: unknown
      try {
        try { await pending.persisted } catch (error) { persistError = error }

        const controller = this.#controllers.get(runId)
        const active = this.#active.get(sessionId)
        if (controller && active) {
          if (!controller.signal.aborted) controller.abort(reason)
          await active.catch(() => {})
        } else {
          await this.markCancelled(pending.launch, view, reason, persistError)
        }
      } finally {
        // The pending entry is the fence the parent is held behind, so it must be
        // released on every path: a throwing terminal append used to leave
        // `shouldFence()` true forever with the manifest still APPROVED_PENDING.
        if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId)
      }
      return true
    }

    if (this.#activeRun.get(sessionId) !== runId) return false
    const active = this.#active.get(sessionId)
    const controller = this.#controllers.get(runId)
    if (!active || !controller) return false
    if (!controller.signal.aborted) controller.abort(reason)
    await active.catch(() => {})
    return true
  }

  async cancelSession(sessionId: string, reason = 'Plan Orchestrator disabled'): Promise<boolean> {
    const runId = this.activeRun(sessionId)
    return runId ? this.cancel(runId, reason) : false
  }

  async cancelAll(reason = 'Plan Orchestrator disabled'): Promise<void> {
    const sessionIds = new Set([...this.#pending.keys(), ...this.#activeRun.keys()])
    await Promise.allSettled([...sessionIds].map(sessionId => this.cancelSession(sessionId, reason)))
  }

  async onParentIdle(sessionId: string): Promise<boolean> {
    const pending = this.#pending.get(sessionId)
    if (!pending || pending.cancelled || this.#active.has(sessionId)) return false
    try { await pending.persisted }
    catch (error) {
      if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId)
      this.failView(pending.runId, 'FAILED', `approval persistence failed: ${(error as Error).message}`)
      return false
    }
    if (pending.cancelled || this.#pending.get(sessionId) !== pending) return false

    let started: boolean
    try {
      started = await this.start(pending.launch, pending.runId)
    } catch (error) {
      // `runMaintenance` can reject synchronously when the agent is no longer
      // idle. The run never reached run(), so fail it closed here: otherwise the
      // pending entry keeps fencing the parent and the manifest stays
      // APPROVED_PENDING + non-terminal forever.
      const message = `maintenance launch failed: ${failureMessage(error)}`
      if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId)
      await this.finalize(pending.launch, pending.runId, terminalPhaseFor(false, message), message).catch(() => {})
      return false
    }
    if (pending.cancelled) {
      // cancel() owns abort/terminal persistence. Do not emit a second terminal
      // event if disable raced with the synchronous launch transition.
      if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId)
      return false
    }
    if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId)
    return started
  }

  async reconcileSession(agent: any): Promise<RunView[]> {
    const sessionId = String(agent.session.id)
    this.#agents.set(sessionId, agent)
    for (const view of reducePlanxEvents(sessionId, agent.session.snapshotEvents?.() ?? [])) this.#views.set(view.runId, view)
    for (const original of await this.store.listSessionManifests(sessionId)) {
      if (original.terminal) continue
      const manifest = interruptManifest(original)
      await this.store.writeManifest(manifest)
      const now = new Date().toISOString()
      const view = this.#views.get(manifest.runId) ?? {
        runId: manifest.runId,
        sessionId,
        phase: 'INTERRUPTED' as RunPhase,
        status: 'INTERRUPTED',
        tasksTotal: 0,
        tasksDone: manifest.completedTaskIds?.length ?? 0,
        activeTaskIds: [],
        reviewRound: 0,
        startedAt: manifest.createdAt,
        updatedAt: now,
      }
      view.phase = 'INTERRUPTED'
      view.status = 'INTERRUPTED'
      view.updatedAt = now
      this.#views.set(manifest.runId, view)
      this.append(agent.session, 'planx/recovery', {
        runId: manifest.runId,
        status: 'INTERRUPTED',
        message: 'Previous process ended before a terminal checkpoint.',
        at: now,
      })
    }
    return this.list(sessionId)
  }

  async resume(runId: string): Promise<{ ok: boolean; reason?: string; resumeFrom?: string }> {
    const view = this.#views.get(runId)
    if (!view || view.phase !== 'INTERRUPTED' || this.#active.has(view.sessionId) || this.#pending.has(view.sessionId)) {
      return { ok: false, reason: 'run is not resumable in current state' }
    }
    const agent = this.#agents.get(view.sessionId)
    if (!agent) return { ok: false, reason: 'session agent unavailable' }
    const manifest = await this.store.readManifest(view.sessionId, runId)
    const dir = this.store.runDir(view.sessionId, runId)
    const checkpoint = await readJson<RecoveryCheckpoint>(join(dir, 'recovery.json')).catch(() => undefined)
    if (!checkpoint) return { ok: false, reason: 'recovery checkpoint missing' }
    const root = await repoRoot(agent.session.header?.cwd ?? process.cwd())
    const diagnosis = await diagnoseResume(root, manifest, checkpoint)
    if (!diagnosis.resumable) return { ok: false, reason: diagnosis.reason }
    const artifact = await readJson<PlanArtifact>(join(dir, 'plan.json'))
    const launch: OrchestratorLaunch = {
      sessionId: view.sessionId,
      agent,
      artifact,
      planHash: manifest.planHash,
      baselineHead: manifest.baselineHead,
      resumeFrom: diagnosis.resumeFrom,
      completedTaskIds: diagnosis.completedTaskIds,
      externalIssue: manifest.externalIssue ? {
        ...manifest.externalIssue,
        publishAfterPass: Boolean(manifest.externalIssue.publishAfterPass),
      } : undefined,
    }
    manifest.phase = diagnosis.resumeFrom
    manifest.terminal = false
    await this.store.writeManifest(manifest)
    const now = new Date().toISOString()
    this.append(agent.session, 'planx/recovery', {
      runId,
      status: 'RESUMING',
      message: `Safe resume from ${diagnosis.resumeFrom}`,
      at: now,
    })
    try {
      await this.start(launch, runId)
    } catch (error) {
      // A resume that cannot start must not stay INTERRUPTED + non-terminal.
      await this.finalize(launch, runId, terminalPhaseFor(false, failureMessage(error)), failureMessage(error))
      return { ok: false, reason: failureMessage(error) }
    }
    return { ok: true, resumeFrom: diagnosis.resumeFrom }
  }

  async cleanup(runId: string): Promise<{ ok: boolean; reason?: string }> {
    const view = this.#views.get(runId)
    if (!view || this.#active.has(view.sessionId)) return { ok: false, reason: 'active or unknown run' }
    const manifest = await this.store.readManifest(view.sessionId, runId).catch(() => undefined)
    if (!manifest?.terminal) return { ok: false, reason: 'only terminal runs may be cleaned' }
    if (manifest.repoRoot) await cleanupRunWorktrees(manifest.repoRoot, runId, this.store.root).catch(() => {})
    await this.store.removeRun(view.sessionId, runId)
    return { ok: true }
  }

  private async start(launch: OrchestratorLaunch, runId: string): Promise<boolean> {
    if (this.#active.has(launch.sessionId)) return false
    const controller = new AbortController()
    this.#controllers.set(runId, controller)
    this.#activeRun.set(launch.sessionId, runId)
    let task: Promise<void>
    try {
      task = launch.agent.runMaintenance(async (signal: AbortSignal) => this.run(launch, runId, AbortSignal.any([signal, controller.signal])))
    } catch (error) {
      this.#controllers.delete(runId)
      if (this.#activeRun.get(launch.sessionId) === runId) this.#activeRun.delete(launch.sessionId)
      throw error
    }
    task = task.finally(() => {
      this.#active.delete(launch.sessionId)
      this.#controllers.delete(runId)
      if (this.#activeRun.get(launch.sessionId) === runId) this.#activeRun.delete(launch.sessionId)
    })
    this.#active.set(launch.sessionId, task)
    void task.catch(() => {})
    return true
  }

  private async run(launch: OrchestratorLaunch, runId: string, signal: AbortSignal): Promise<void> {
    let terminalPhase: 'COMPLETE'|'BLOCKED'|'FAILED'|'CANCELLED' = 'COMPLETE'
    let terminalMessage: string | undefined
    let terminalCause: unknown
    let thrown: unknown
    let failed = false
    try {
      try {
        const initial = await this.store.readManifest(launch.sessionId, runId)
        initial.phase = launch.resumeFrom ?? 'PREFLIGHT'
        initial.terminal = false
        await this.store.writeManifest(initial)
        this.recordEvent('phase', { runId, phase: initial.phase })
      } catch (error) {
        // PREFLIGHT startup must fail closed: an exception in the initial phase
        // event or manifest write must not leave a permanently non-terminal run.
        thrown = error
        failed = true
        terminalCause = error
        terminalMessage = failureMessage(error)
        terminalPhase = terminalPhaseFor(signal.aborted, terminalMessage, failureCode(error))
      }
      if (!failed) {
        try {
          await this.runner(launch, runId, signal)
          // A runner may cooperate with abort by resolving instead of rejecting.
          // The run was still cancelled, so it must not be recorded as COMPLETE.
          if (signal.aborted && terminalPhase === 'COMPLETE') {
            terminalMessage = 'run aborted before completion'
            terminalPhase = 'CANCELLED'
          }
        } catch (error) {
          thrown = error
          failed = true
          terminalCause = error
          terminalMessage = failureMessage(error)
          terminalPhase = terminalPhaseFor(signal.aborted, terminalMessage, failureCode(error))
        }
      }
    } finally {
      await this.finalize(launch, runId, terminalPhase, terminalMessage, terminalCause)
    }
    if (failed) throw thrown
  }

  /**
   * Best-effort terminal manifest write. Returns the failure instead of
   * throwing so the caller can decide how to converge.
   */
  private async writeTerminal(launch: OrchestratorLaunch, runId: string, phase: string, failureArtifact?: { sha256: string; bytes: number }): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const latest = await this.store.readManifest(launch.sessionId, runId)
      latest.phase = phase
      latest.terminal = true
      if (failureArtifact) latest.failureArtifact = failureArtifact
      await this.store.writeManifest(latest)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /**
   * Persist the run's own failure account next to the manifest.
   *
   * The manifest carries only a phase, and the phase event's message is the last
   * one written — the failed run 4429470e kept the generic
   * `subagent t1-report-module stopped: error` while the real cause (the SDK lane
   * was unavailable, so the wave downgraded to serial) had already been
   * overwritten. This record keeps both the terminal message and the cause chain
   * so a finished run stays diagnosable after the process is gone.
   *
   * Never throws: losing the diagnosis must not change the terminal phase.
   */
  private async writeFailureRecord(
    launch: OrchestratorLaunch,
    runId: string,
    phase: string,
    message: string | undefined,
    cause: unknown,
  ): Promise<{ sha256: string; bytes: number } | undefined> {
    try {
      const record = {
        schemaVersion: 1,
        runId,
        phase,
        stage: this.#views.get(runId)?.phase ?? phase,
        ...(message ? { message } : {}),
        cause: {
          ...(failureCode(cause) ? { code: failureCode(cause) } : {}),
          message: failureMessage(cause),
          chain: failureChain(cause),
        },
        at: new Date().toISOString(),
      }
      const body = `${JSON.stringify(record, null, 2)}\n`
      const dir = this.store.runDir(launch.sessionId, runId)
      const sha256 = await atomicJson(join(dir, 'failure.json'), record)
      return { sha256, bytes: Buffer.byteLength(body, 'utf8') }
    } catch {
      return undefined
    }
  }

  /**
   * Persist the terminal state. Never throws: a session whose append is
   * unavailable must still not be left with a non-terminal manifest.
   *
   * This is also the single delivery point for the terminal report, so every
   * outcome — COMPLETE, BLOCKED, FAILED and CANCELLED — reaches the parent
   * conversation from one place instead of only the engine's COMPLETE-only
   * `inject`, which never woke the driver.
   */
  private async finalize(launch: OrchestratorLaunch, runId: string, phase: string, message?: string, cause?: unknown): Promise<void> {
    if (!TERMINAL_PHASES.has(phase)) throw new Error(`plan-orchestrator refusing non-terminal finalize phase: ${phase}`)
    const at = new Date().toISOString()
    let effectivePhase = phase
    let effectiveMessage = message
    let failureArtifact: { sha256: string; bytes: number } | undefined
    if (effectivePhase !== 'COMPLETE' && effectivePhase !== 'CANCELLED') {
      failureArtifact = await this.writeFailureRecord(launch, runId, effectivePhase, effectiveMessage, cause)
    }
    const written = await this.writeTerminal(launch, runId, effectivePhase, failureArtifact)
    if (!written.ok) {
      // Terminal persistence failed, so the run can no longer be reported as its
      // intended phase. Converge on FAILED — no later step may announce
      // COMPLETE/BLOCKED/CANCELLED — then retry the write once: a transient
      // storage failure must not leave the on-disk manifest non-terminal, which
      // recovery would later misread as INTERRUPTED even though the runtime
      // already knows this run failed.
      effectivePhase = 'FAILED'
      effectiveMessage = `terminal manifest persistence failed: ${failureMessage(written.error)}`
      failureArtifact = await this.writeFailureRecord(launch, runId, effectivePhase, effectiveMessage, written.error)
      const retry = await this.writeTerminal(launch, runId, effectivePhase, failureArtifact)
      if (!retry.ok) effectiveMessage = `${effectiveMessage}; retry failed: ${failureMessage(retry.error)}`
      try { launch.agent?.session?.append?.('planx/finalize-error', { runId, phase: effectivePhase, message: effectiveMessage, at }) } catch { /* containment: the run view is the last resort */ }
      try { this.failView(runId, 'FAILED', effectiveMessage, at) } catch { /* containment: never rethrow out of finalize */ }
    }
    try {
      this.recordEvent('phase', { runId, phase: effectivePhase, ...(effectiveMessage !== undefined ? { message: effectiveMessage } : {}) })
    } catch { /* the manifest already records the terminal phase */ }
    try {
      this.append(launch.agent.session, 'planx/run-terminal', {
        runId,
        phase: effectivePhase,
        ...(effectiveMessage ? { message: effectiveMessage } : {}),
        at,
      })
    } catch { /* the manifest already records the terminal phase */ }
    await this.deliverReport(launch, runId, effectivePhase, effectiveMessage)
  }

  /**
   * Hand the bounded terminal report to the parent conversation exactly once.
   *
   * Contained on every path: a delivery surface that is missing or throwing must
   * never change the phase the run already recorded.
   */
  private async deliverReport(launch: OrchestratorLaunch, runId: string, phase: string, message?: string): Promise<void> {
    if (!isTerminalPhase(phase) || this.#reported.has(runId)) return
    this.#reported.add(runId)
    try {
      const view = this.#views.get(runId)
      const dir = this.store.runDir(launch.sessionId, runId)
      const completion = await readJson<any>(join(dir, 'completion.json')).catch(() => undefined)
      const text = terminalReportText(runId, phase, message, launch.artifact, view, completion)
      deliverTerminalReport(launch.agent, runId, phase, text)
    } catch { /* containment: a report failure is not a run failure */ }
  }

  private async persistApproval(launch: OrchestratorLaunch, runId: string, now: string): Promise<void> {
    const dir = this.store.runDir(launch.sessionId, runId)
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      sessionId: launch.sessionId,
      planHash: launch.planHash,
      phase: 'APPROVED_PENDING',
      terminal: false,
      createdAt: now,
      updatedAt: now,
      baselineHead: launch.baselineHead,
      ownership: [...new Set(launch.artifact.tasks.flatMap(task => task.modify))].sort(),
      completedTaskIds: [],
      externalIssue: launch.externalIssue ? {
        issueNumber: launch.externalIssue.issueNumber,
        repository: launch.externalIssue.repository,
        revision: launch.externalIssue.revision,
        branch: launch.externalIssue.branch,
        publishAfterPass: launch.externalIssue.publishAfterPass,
      } : undefined,
      artifacts: {},
    }
    await this.store.writeManifest(manifest)
    await atomicJson(join(dir, 'plan.json'), launch.artifact)
  }

  private async markCancelled(launch: OrchestratorLaunch, view: RunView, reason: string, persistError?: unknown): Promise<void> {
    view.phase = 'CANCELLED'
    view.status = 'CANCELLED'
    view.activeTaskIds = []
    view.message = persistError ? `${reason}; approval persistence failed: ${(persistError as Error).message}` : reason
    view.updatedAt = new Date().toISOString()
    // Contained: a session whose append is unavailable must still converge on a
    // terminal manifest, because the pending fence is released by the caller and
    // the manifest is the only durable record left.
    try {
      this.append(this.#agents.get(view.sessionId)?.session, 'planx/run-terminal', {
        runId: view.runId, phase: 'CANCELLED', message: view.message, at: view.updatedAt,
      })
    } catch { /* the manifest below is the durable record */ }
    const manifest = await this.store.readManifest(view.sessionId, view.runId).catch(() => undefined)
    if (manifest) {
      manifest.phase = 'CANCELLED'
      manifest.terminal = true
      await this.store.writeManifest(manifest).catch(() => {})
    }
    // A cancelled run still reports; CANCELLED is the non-waking phase, so this
    // queues context without forcing a turn for a run the user stopped.
    await this.deliverReport(launch, view.runId, 'CANCELLED', view.message)
  }

  private append(session: any, type: string, data: any): void {
    if (!session || typeof session.append !== 'function') throw new Error(`plan-orchestrator cannot persist ${type}: session append unavailable`)
    assertNoUndefinedEventData(data, type)
    session.append(type, data)
  }

  private failView(runId: string, phase: 'FAILED'|'BLOCKED', message: string, at = new Date().toISOString()): void {
    const view = this.#views.get(runId)
    if (!view) return
    view.phase = phase
    view.status = phase
    view.message = message
    view.updatedAt = at
    // Containment: the caller may already be handling a persistence failure, so
    // an unavailable session append must not become a second escaping error.
    try {
      this.append(this.#agents.get(view.sessionId)?.session, 'planx/run-terminal', { runId, phase, message, at })
    } catch { /* the run view already carries the terminal phase */ }
  }

  private async latestReview(dir: string, round: number): Promise<any> {
    for (let index = round; index >= 0; index--) {
      const value = await readJson<any>(join(dir, `review-${index}.json`)).catch(() => undefined)
      if (value) return value
    }
    return undefined
  }
}

export function installParentFence(ctx: any, service: OrchestrationService) {
  const preStep = ctx.on('agent/pre-step', async ({ agent }: any, next: any) => {
    const sessionId = String(agent.session.id)
    if (!service.shouldFence(sessionId)) return next()
    await next()
    return { kind: 'reject' as const }
  }, { prepend: true })
  const status = ctx.on('agent/status', ({ agent, status }: any) => {
    if (status === 'idle') void service.onParentIdle(String(agent.session.id)).catch((error: any) => {
      ctx.logger?.error?.('plan-orchestrator maintenance launch failed: %o', error)
    })
  })
  return () => { preStep?.(); status?.() }
}
