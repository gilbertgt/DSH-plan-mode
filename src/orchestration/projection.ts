import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RunPhase, RunProjection } from '../contract/events.ts'

const PHASES = [
  'IDLE', 'PLANNING', 'PLAN_VALIDATED', 'APPROVED_PENDING', 'PREFLIGHT', 'WORKERS',
  'INTEGRATING', 'VALIDATING', 'REVIEWING', 'FIXING', 'COMPLETE', 'BLOCKED',
  'FAILED', 'INTERRUPTED', 'CANCELLED',
] as const satisfies readonly RunPhase[]

const phaseSchema = z.enum(PHASES)
const runSchema = z.object({
  runId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(300),
  phase: phaseSchema,
  status: z.string().max(100),
  tasksTotal: z.number().int().nonnegative(),
  tasksDone: z.number().int().nonnegative(),
  activeTaskIds: z.array(z.string().max(200)).max(64),
  reviewRound: z.number().int().nonnegative(),
  message: z.string().max(2000).optional(),
  startedAt: z.string().max(64),
  updatedAt: z.string().max(64),
}).strict()

const stateSchema = z.object({ runs: z.array(runSchema).max(20) }).strict()
type State = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'planx/run-approved': { runId: string; sessionId: string; planHash: string; tasksTotal: number; at: string }
    'planx/run-phase': { runId: string; phase: RunPhase; message?: string; reviewRound?: number; at: string }
    'planx/task-start': { runId: string; taskId: string; at: string }
    'planx/task-end': { runId: string; taskId: string; status: string; at: string }
    'planx/validation': { runId: string; commandId: string; status: string; at: string }
    'planx/review': { runId: string; round: number; verdict: string; at: string }
    'planx/recovery': { runId: string; status: string; message?: string; at: string }
    'planx/run-terminal': { runId: string; phase: 'COMPLETE'|'BLOCKED'|'FAILED'|'INTERRUPTED'|'CANCELLED'; message?: string; at: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    planOrchestrator: State
  }
  interface SessionProjectionMap {
    planOrchestrator: State
  }
}

function replaceRun(state: State, run: RunProjection): State {
  const runs = [run, ...state.runs.filter(row => row.runId !== run.runId)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20)
  return { runs }
}

function find(state: State, runId: string): RunProjection | undefined {
  return state.runs.find(run => run.runId === runId) as RunProjection | undefined
}

export const planOrchestratorProjectionDefinition = {
  key: 'planOrchestrator',
  stateVersion: 1,
  stateSchema,
  init: (): State => ({ runs: [] }),
  apply: (state: State, event: any): State => {
    const d = event.data as any
    if (event.type === 'planx/run-approved') {
      return replaceRun(state, {
        runId: d.runId,
        sessionId: d.sessionId,
        phase: 'APPROVED_PENDING',
        status: 'APPROVED_PENDING',
        tasksTotal: d.tasksTotal,
        tasksDone: 0,
        activeTaskIds: [],
        reviewRound: 0,
        startedAt: d.at,
        updatedAt: d.at,
      })
    }
    if (typeof d?.runId !== 'string') return state
    const current = find(state, d.runId)
    if (!current) return state
    let next: RunProjection = { ...current, activeTaskIds: [...current.activeTaskIds] }
    switch (event.type) {
      case 'planx/run-phase':
        next.phase = d.phase
        next.status = d.phase
        if (typeof d.reviewRound === 'number') next.reviewRound = d.reviewRound
        if (typeof d.message === 'string') next.message = d.message
        break
      case 'planx/task-start':
        if (!next.activeTaskIds.includes(d.taskId)) next.activeTaskIds.push(d.taskId)
        break
      case 'planx/task-end':
        next.activeTaskIds = next.activeTaskIds.filter(id => id !== d.taskId)
        next.tasksDone = Math.min(next.tasksTotal, next.tasksDone + 1)
        break
      case 'planx/review':
        next.reviewRound = d.round
        break
      case 'planx/recovery':
        next.status = d.status
        if (typeof d.message === 'string') next.message = d.message
        break
      case 'planx/run-terminal':
        next.phase = d.phase
        next.status = d.phase
        next.activeTaskIds = []
        if (typeof d.message === 'string') next.message = d.message
        break
      default:
        return state
    }
    next.updatedAt = d.at
    return replaceRun(state, next)
  },
  wire: {
    viewSchema: stateSchema,
    view: (state: State) => state,
  },
} satisfies ProjectionDefinition<'planOrchestrator', State>
