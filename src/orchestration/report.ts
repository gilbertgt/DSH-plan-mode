import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PlanArtifact } from '../contract/plan-artifact.ts'
import type { RunProjection } from '../contract/events.ts'

export type TerminalPhase = 'COMPLETE' | 'BLOCKED' | 'FAILED' | 'CANCELLED'

/**
 * Upper bound for one terminal report, in UTF-16 code units.
 *
 * The report is written into the parent conversation, whose context is shared
 * with everything else in the session, so the account of a finished run must
 * not be able to grow with the size of the run. 8000 chars is comfortably
 * above a fully populated report (plan summary, 20 changed paths, 4 receipts,
 * usage) and well below the smallest provider context window this plugin
 * supports.
 */
export const REPORT_MAX_CHARS = 8000
/** Marker appended when {@link terminalReportText} hits {@link REPORT_MAX_CHARS}. */
export const REPORT_TRUNCATION_MARKER = '… [report truncated]'
/** Changed paths shown in full before the remainder is summarised by count. */
export const REPORT_MAX_PATHS = 20

/** `completion.json` as written by the engine at the end of a terminal run. */
export interface CompletionRecord {
  runId?: string
  planHash?: string
  review?: string
  changedPaths?: string[]
  ownershipFingerprint?: string
  receipts?: unknown
  usage?: unknown
  completedAt?: string
}

/**
 * Delivery surface used by {@link deliverTerminalReport}.
 *
 * Declared structurally and permissively because the same function serves the
 * live `agent` object and the recording doubles the tests install in its place.
 */
export interface ReportDeliveryAgent {
  followup?: (message: unknown) => unknown
  inject?: (message: unknown) => unknown
}

/** Which of the two delivery surfaces actually accepted the message. */
export type ReportDelivery = 'followup' | 'inject' | 'none'

/** One line of the validation receipt index, read only from its bounded fields. */
interface ReceiptLineSource {
  commandId?: unknown
  command?: unknown
  status?: unknown
  exitCode?: unknown
  boundHead?: unknown
  ownershipFingerprint?: unknown
  stdout?: unknown
  stderr?: unknown
  complete?: unknown
}

/** A single rendered `key: value` line; the value is optional by design. */
interface Line {
  key: string
  value?: string
}

const MAX_PLAN_SUMMARY = 240
const MAX_MESSAGE = 240
const MAX_FIELD = MAX_MESSAGE
const MAX_BLOCKER = 400
const MAX_TASK_TITLE = 80
const MAX_PATH = 120
const MAX_COMMAND = 120
const MAX_REVIEW = 240
const MAX_TOKEN = 80
const HASH_PREFIX = 12
const DEFAULT_SUMMARY_LIMIT = 96

/** A model-facing "one line" summary tolerates at most one newline-free line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/** Normalise any thrown/optional value into a single bounded line. */
function boundField(value: unknown, limit: number = MAX_FIELD): string | undefined {
  if (typeof value === 'string') {
    const single = oneLine(value)
    return single ? clipText(single, limit) : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function fieldToken(value: unknown, limit = MAX_TOKEN): string | undefined {
  if (typeof value === 'string') {
    const single = oneLine(value)
    return single ? clipText(single, limit) : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function hashPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const single = oneLine(value)
  if (!single) return undefined
  return single.length <= HASH_PREFIX ? single : single.slice(0, HASH_PREFIX)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function formatCount(value: number): string {
  return String(Math.max(0, Math.trunc(value)))
}

/**
 * Render `key: value` for every line that has a value.
 *
 * A missing value drops its whole line, so the three terminal phases that carry
 * no blocker produce no empty field instead of a dangling label.
 */
function renderLines(lines: Line[]): string {
  return lines
    .filter((line): line is { key: string; value: string } => typeof line.value === 'string' && line.value.length > 0)
    .map(line => `${line.key}: ${line.value}`)
    .join('\n')
}

function planLines(plan?: PlanArtifact): Line[] {
  if (!plan) return []
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const summary = boundField(plan.summary, MAX_PLAN_SUMMARY)
  const taskWord = tasks.length === 1 ? 'task' : 'tasks'
  return [
    { key: 'Plan summary', value: summary },
    { key: 'Complexity', value: boundField(plan.complexity) },
    { key: 'Plan', value: `${formatCount(tasks.length)} ${taskWord}` },
    { key: 'Task summary', value: taskSummaries(tasks) },
  ]
}

/** Bounded `id: title` recap; the plan data is the only source for it. */
function taskSummaries(tasks: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const raw of tasks.slice(0, 8)) {
    if (!isRecord(raw)) continue
    const id = fieldToken(raw.id, 60)
    if (!id) continue
    const title = boundField(raw.title, MAX_TASK_TITLE)
    parts.push(title ? `${id} (${title})` : id)
  }
  if (!parts.length) return undefined
  const hidden = tasks.length - parts.length
  return hidden > 0 ? `${parts.join(', ')}, +${formatCount(hidden)} more` : parts.join(', ')
}

function headerLines(runId: string, phase: TerminalPhase, projection?: RunProjection): Line[] {
  const total = typeof projection?.tasksTotal === 'number' ? Math.max(0, Math.trunc(projection.tasksTotal)) : undefined
  const done = typeof projection?.tasksDone === 'number' ? Math.max(0, Math.trunc(projection.tasksDone)) : undefined
  const progress = total === undefined
    ? (done === undefined ? undefined : `${formatCount(done)} completed`)
    : `${formatCount(Math.min(done ?? 0, total))}/${formatCount(total)} completed`
  return [
    { key: 'Plan Orchestrator', value: `run ${runId || '(unknown run)'} finished as ${phase}` },
    { key: 'Progress', value: progress },
    { key: 'Review round', value: typeof projection?.reviewRound === 'number' ? formatCount(projection.reviewRound) : undefined },
    { key: 'Status', value: boundField(projection?.status, MAX_TOKEN) },
  ]
}

/**
 * The blocker line. BLOCKED and FAILED carry the orchestrator's own failure
 * account; it is reproduced verbatim (after whitespace collapsing, which is
 * what keeps it on one line) because it is usually the only actionable text.
 */
function blockerLines(phase: TerminalPhase, blocker?: string): Line[] {
  const wanted = phase === 'BLOCKED' || phase === 'FAILED'
  const value = boundField(blocker, MAX_BLOCKER)
  if (!wanted && !value) return []
  return [{ key: 'Blocker', value: value ?? 'no blocker message was recorded' }]
}

function reviewLines(completion?: CompletionRecord): Line[] {
  return [{ key: 'Reviewer verdict', value: boundField(completion?.review, MAX_REVIEW) }]
}

function changedPathLines(completion?: CompletionRecord): Line[] {
  const paths = Array.isArray(completion?.changedPaths) ? completion.changedPaths : []
  const clean = paths.filter((path): path is string => typeof path === 'string' && Boolean(oneLine(path)))
  if (!clean.length) return [{ key: 'Changed paths', value: '(none)' }]
  const shown = clean.slice(0, REPORT_MAX_PATHS).map(path => clipText(oneLine(path), MAX_PATH))
  const hidden = clean.length - shown.length
  const value = hidden > 0 ? `${shown.join(', ')}, +${formatCount(hidden)} more` : shown.join(', ')
  return [{ key: `Changed paths (${formatCount(clean.length)})`, value }]
}

/** Accept the engine's array index or a `commandId`-keyed object. */
function receiptEntries(receipts: unknown): Array<[string | undefined, ReceiptLineSource]> {
  if (Array.isArray(receipts)) {
    return receipts.map(entry => [undefined, isRecord(entry) ? entry as ReceiptLineSource : {}])
  }
  if (isRecord(receipts)) {
    return Object.keys(receipts).sort().map(key => {
      const entry = receipts[key]
      return [key, isRecord(entry) ? entry as ReceiptLineSource : {}]
    })
  }
  return []
}

/**
 * One line per receipt, deliberately limited to the index fields.
 *
 * `stdout`/`stderr` bodies live in separate files and are never read here: this
 * module has no filesystem access at all, so a validation stream cannot reach
 * the conversation even by accident. Only their digests are ever touched, and
 * only to be left out.
 */
function receiptText(entry: ReceiptLineSource, keyed?: string): string | undefined {
  const id = fieldToken(entry.commandId, 80) ?? fieldToken(keyed, 80)
  if (!id) return undefined
  const parts: string[] = [fieldToken(entry.status, 40) ?? 'UNKNOWN']
  const exitCode = fieldToken(entry.exitCode, 20)
  parts.push(exitCode === undefined ? 'exit n/a' : `exit ${exitCode}`)
  const head = hashPrefix(entry.boundHead)
  parts.push(head ? `head ${head}` : 'head n/a')
  const ownership = hashPrefix(entry.ownershipFingerprint)
  parts.push(ownership ? `ownership ${ownership}` : 'ownership n/a')
  if (entry.complete === false) parts.push('incomplete')
  const command = boundField(entry.command, MAX_COMMAND)
  return `- ${id}: ${parts.join(', ')}${command ? ` — ${command}` : ''}`
}

function validationLines(completion?: CompletionRecord): Line[] {
  const entries = receiptEntries(completion?.receipts)
  if (!entries.length) return [{ key: 'Validation receipts', value: '(none)' }]
  const lines = entries.map(([key, entry]) => receiptText(entry, key)).filter((line): line is string => Boolean(line))
  if (!lines.length) return [{ key: 'Validation receipts', value: '(none)' }]
  return [{ key: 'Validation receipts', value: `\n${lines.join('\n')}` }]
}

function usageLines(explicit: unknown, fromCompletion: unknown): Line[] {
  const usage = explicit ?? fromCompletion
  if (!usage) return []
  if (Array.isArray(usage)) return [{ key: 'Usage', value: `${formatCount(usage.length)} samples recorded` }]
  if (!isRecord(usage)) return []
  const parts: string[] = []
  const input = fieldToken(usage.input, 24)
  const output = fieldToken(usage.output, 24)
  const turns = fieldToken(usage.turns, 24)
  const durationMs = fieldToken(usage.durationMs, 24)
  if (input !== undefined) parts.push(`input ${input}`)
  if (output !== undefined) parts.push(`output ${output}`)
  if (turns !== undefined) parts.push(`turns ${turns}`)
  if (durationMs !== undefined) parts.push(`durationMs ${durationMs}`)
  if (!parts.length) return []
  return [{ key: 'Usage', value: parts.join(', ') }]
}

/**
 * Compose the deterministic terminal report for one finished run.
 *
 * Every input is optional except the run id and the terminal phase, every
 * variable field is individually bounded, and the whole text is capped at
 * {@link REPORT_MAX_CHARS}. Two calls with the same inputs always produce the
 * same string: no clock, no randomness, no filesystem or session access.
 */
export function terminalReportText(
  runId: string,
  phase: TerminalPhase,
  blocker: string | undefined,
  plan: PlanArtifact | undefined,
  projection: RunProjection | undefined,
  completion?: CompletionRecord,
  usage?: unknown,
): string {
  const body = renderLines([
    ...headerLines(String(runId ?? ''), phase, projection),
    ...blockerLines(phase, blocker),
    ...planLines(plan),
    ...reviewLines(completion),
    ...changedPathLines(completion),
    ...validationLines(completion),
    ...usageLines(usage, completion?.usage),
  ])
  if (body.length <= REPORT_MAX_CHARS) return body
  const keep = Math.max(0, REPORT_MAX_CHARS - REPORT_TRUNCATION_MARKER.length)
  return `${body.slice(0, keep)}${REPORT_TRUNCATION_MARKER}`
}

/**
 * Wrap the report as the plugin-sourced user message the parent receives.
 *
 * The prose keeps the report inside the model-facing content; `summary` is the
 * collapsed transcript row's one-line account and is bounded by the harness.
 */
export function buildReportMessage(runId: string, phase: TerminalPhase, text: string): unknown {
  const progress = `${phase} ${oneLine(String(runId ?? '')) || '(unknown run)'}`.trim()
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'plan-orchestrator',
      form: 'notice',
      summary: boundContextSummary(`Plan Orchestrator ${progress}`),
    },
  })
}

/**
 * Bound the one-line summary exactly as the harness does, so callers that need
 * the summary text itself (tests, logs) do not have to reimplement the rule.
 */
export function reportSummary(runId: string, phase: TerminalPhase, limit = DEFAULT_SUMMARY_LIMIT): string {
  const raw = `Plan Orchestrator ${phase} ${oneLine(String(runId ?? '')) || '(unknown run)'}`
  if (raw.length <= limit) return raw
  return `${raw.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Hand one terminal report to the parent conversation exactly once.
 *
 * COMPLETE, BLOCKED and FAILED use `followup`, so the parent gains a turn and
 * actually reads the outcome; CANCELLED uses `inject`, which queues context
 * without waking the driver or forcing a turn for a run the user stopped.
 *
 * Never throws and never mutates the terminal phase: a delivery surface that is
 * missing or throwing degrades to the next one and finally to a silent no-op,
 * because losing the announcement must not turn a recorded outcome into a
 * different one.
 */
export function deliverTerminalReport(
  agent: ReportDeliveryAgent | undefined,
  runId: string,
  phase: TerminalPhase,
  text: string,
): ReportDelivery {
  let message: unknown
  try {
    message = buildReportMessage(runId, phase, text)
  } catch {
    return 'none'
  }

  const followup = agent?.followup
  const inject = agent?.inject

  if (phase !== 'CANCELLED') {
    try {
      if (typeof followup !== 'function') throw new Error('followup unavailable')
      followup.call(agent, message)
      return 'followup'
    } catch { /* fall through to inject */ }
  }

  try {
    if (typeof inject !== 'function') throw new Error('inject unavailable')
    inject.call(agent, message)
    return 'inject'
  } catch { /* no delivery surface accepted the report */ }

  return 'none'
}
