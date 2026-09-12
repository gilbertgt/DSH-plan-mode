export const SETTINGS_NAMESPACE = 'plan-orchestrator'
export type RoleName = 'planner' | 'worker' | 'integrator' | 'reviewer'
export type RouteMode = 'current' | 'fixed'
export type WorkspaceRouteMode = 'inherit' | RouteMode

export interface RouteChoice {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface RoleRoute {
  mode: RouteMode
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
  fallbacks: RouteChoice[]
}

export interface WorkspaceRoleRoute extends Omit<RoleRoute, 'mode'> {
  mode: WorkspaceRouteMode
}

export interface WorkspaceOverride {
  roles?: Partial<Record<RoleName, WorkspaceRoleRoute>>
}

export interface PlanSettings {
  enabled: boolean
  roles: Record<RoleName, RoleRoute>
  planning: {
    adaptiveResearch: boolean
    strictReadOnly: boolean
    maxInitialReadFiles: number
    softInputTokens: number
    progressiveDiscovery: boolean
    requireExpansionReason: boolean
  }
  execution: {
    maxParallelWorkers: number
    parallelMode: 'auto' | 'serial' | 'worktree'
    requireExplicitOwnership: true
    keepFailedWorktrees: boolean
    sdkProfile: string
    roleTimeoutMs: number
  }
  review: {
    maxReviewRounds: number
    protocolRetry: number
    trustedValidation: true
    outputCapBytes: number
  }
  recovery: { allowSafeResume: boolean }
  externalIssue: { enabled: boolean; publishAfterPass: boolean }
  workspaceOverrides: Record<string, WorkspaceOverride>
}

const ROLE_NAMES: readonly RoleName[] = ['planner', 'worker', 'integrator', 'reviewer']
const SETTINGS_KEYS = new Set(['enabled', 'roles', 'planning', 'execution', 'review', 'recovery', 'externalIssue', 'workspaceOverrides'])
const ROUTE_KEYS = new Set(['mode', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'fallbacks'])
const CHOICE_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'maxTokens'])
const PLANNING_KEYS = new Set(['adaptiveResearch', 'strictReadOnly', 'maxInitialReadFiles', 'softInputTokens', 'progressiveDiscovery', 'requireExpansionReason'])
const EXECUTION_KEYS = new Set(['maxParallelWorkers', 'parallelMode', 'requireExplicitOwnership', 'keepFailedWorktrees', 'sdkProfile', 'roleTimeoutMs'])
const REVIEW_KEYS = new Set(['maxReviewRounds', 'protocolRetry', 'trustedValidation', 'outputCapBytes'])
const RECOVERY_KEYS = new Set(['allowSafeResume'])
const EXTERNAL_KEYS = new Set(['enabled', 'publishAfterPass'])
const WORKSPACE_KEYS = new Set(['roles'])

export const defaultRoute = (): RoleRoute => ({ mode: 'current', fallbacks: [] })

/**
 * Rebuild one route choice with every optional field present only when it holds
 * a real value. Every DSH boundary this plugin crosses — `Session.append`,
 * subagent descriptor snapshots, `llm.resolveCallConfig` and SDK child options —
 * validates lossless JSON, where an explicitly `undefined` property is rejected
 * while an absent one is fine. An unresolved (inherited) route legitimately has
 * no provider/model yet, so those are omitted too rather than written as
 * `undefined`; `routeChoices` filters such a candidate out before use.
 */
export function losslessRouteChoice(choice: RouteChoice): RouteChoice {
  const route: Record<string, unknown> = {}
  if (choice.provider !== undefined) route.provider = choice.provider
  if (choice.model !== undefined) route.model = choice.model
  if (choice.reasoningEffort !== undefined) route.reasoningEffort = choice.reasoningEffort
  if (choice.maxTokens !== undefined) route.maxTokens = choice.maxTokens
  return route as unknown as RouteChoice
}

export const DEFAULT_SETTINGS: PlanSettings = Object.freeze<PlanSettings>({
  enabled: true,
  roles: {
    planner: defaultRoute(),
    worker: defaultRoute(),
    integrator: defaultRoute(),
    reviewer: defaultRoute(),
  },
  planning: {
    adaptiveResearch: true,
    strictReadOnly: true,
    maxInitialReadFiles: 6,
    softInputTokens: 20_000,
    progressiveDiscovery: true,
    requireExpansionReason: true,
  },
  execution: {
    maxParallelWorkers: 3,
    parallelMode: 'auto',
    requireExplicitOwnership: true,
    keepFailedWorktrees: true,
    sdkProfile: 'sdk',
    roleTimeoutMs: 900_000,
  },
  review: {
    maxReviewRounds: 2,
    protocolRetry: 1,
    trustedValidation: true,
    outputCapBytes: 16 * 1024 * 1024,
  },
  recovery: { allowSafeResume: true },
  externalIssue: { enabled: false, publishAfterPass: false },
  workspaceOverrides: {},
})

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`)
  return value as Record<string, unknown>
}

function strictKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${where} has unknown field(s): ${unknown.join(', ')}`)
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where} must be boolean`)
  return value
}

function integer(value: unknown, where: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${where} must be an integer from ${min} through ${max}`)
  }
  return value as number
}

function optionalString(value: unknown, where: string, max = 256): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`${where} invalid`)
  return value
}

function routeChoice(value: unknown, where: string): RouteChoice {
  const x = object(value, where)
  strictKeys(x, CHOICE_KEYS, where)
  const provider = optionalString(x.provider, `${where}.provider`)
  const model = optionalString(x.model, `${where}.model`)
  if (!provider || !model) throw new Error(`${where} needs provider and model`)
  const reasoningEffort = optionalString(x.reasoningEffort, `${where}.reasoningEffort`, 64)
  const maxTokens = x.maxTokens === undefined ? undefined : integer(x.maxTokens, `${where}.maxTokens`, 1, 2_000_000)
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) }
}

function roleRoute(value: unknown, where: string, workspace: boolean): RoleRoute | WorkspaceRoleRoute {
  const x = object(value, where)
  strictKeys(x, ROUTE_KEYS, where)
  const allowedModes = workspace ? ['inherit', 'current', 'fixed'] : ['current', 'fixed']
  if (typeof x.mode !== 'string' || !allowedModes.includes(x.mode)) throw new Error(`${where}.mode invalid`)
  const mode = x.mode as WorkspaceRouteMode
  const provider = optionalString(x.provider, `${where}.provider`)
  const model = optionalString(x.model, `${where}.model`)
  const reasoningEffort = optionalString(x.reasoningEffort, `${where}.reasoningEffort`, 64)
  const maxTokens = x.maxTokens === undefined ? undefined : integer(x.maxTokens, `${where}.maxTokens`, 1, 2_000_000)
  if (mode === 'fixed' && (!provider || !model)) throw new Error(`${where} fixed route needs provider and model`)
  if (mode !== 'fixed' && (provider !== undefined || model !== undefined || reasoningEffort !== undefined || maxTokens !== undefined)) {
    throw new Error(`${where} ${mode} route cannot carry fixed-route fields`)
  }
  if (!Array.isArray(x.fallbacks) || x.fallbacks.length > 8) throw new Error(`${where}.fallbacks invalid`)
  const fallbacks = x.fallbacks.map((item, index) => routeChoice(item, `${where}.fallbacks[${index}]`))
  const route = { mode, fallbacks, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) }
  return route as RoleRoute | WorkspaceRoleRoute
}

function section(value: unknown, allowed: Set<string>, where: string): Record<string, unknown> {
  const x = object(value, where)
  strictKeys(x, allowed, where)
  return x
}

export function validateSettings(value: unknown): PlanSettings {
  const x = object(value, 'settings')
  strictKeys(x, SETTINGS_KEYS, 'settings')
  const rolesRaw = object(x.roles, 'settings.roles')
  strictKeys(rolesRaw, new Set(ROLE_NAMES), 'settings.roles')
  const roles = Object.fromEntries(ROLE_NAMES.map(role => [role, roleRoute(rolesRaw[role], `settings.roles.${role}`, false)])) as Record<RoleName, RoleRoute>

  const planning = section(x.planning, PLANNING_KEYS, 'settings.planning')
  const execution = section(x.execution, EXECUTION_KEYS, 'settings.execution')
  const review = section(x.review, REVIEW_KEYS, 'settings.review')
  const recovery = section(x.recovery, RECOVERY_KEYS, 'settings.recovery')
  const externalIssue = section(x.externalIssue, EXTERNAL_KEYS, 'settings.externalIssue')
  const workspaceRaw = object(x.workspaceOverrides, 'settings.workspaceOverrides')
  const workspaceOverrides: Record<string, WorkspaceOverride> = {}
  if (Object.keys(workspaceRaw).length > 256) throw new Error('settings.workspaceOverrides has too many entries')
  for (const [workspaceKey, raw] of Object.entries(workspaceRaw)) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(workspaceKey)) throw new Error(`invalid workspace override key: ${workspaceKey}`)
    const override = object(raw, `settings.workspaceOverrides.${workspaceKey}`)
    strictKeys(override, WORKSPACE_KEYS, `settings.workspaceOverrides.${workspaceKey}`)
    const result: WorkspaceOverride = {}
    if (override.roles !== undefined) {
      const roleObject = object(override.roles, `settings.workspaceOverrides.${workspaceKey}.roles`)
      strictKeys(roleObject, new Set(ROLE_NAMES), `settings.workspaceOverrides.${workspaceKey}.roles`)
      result.roles = {}
      for (const [role, route] of Object.entries(roleObject)) {
        result.roles[role as RoleName] = roleRoute(route, `settings.workspaceOverrides.${workspaceKey}.roles.${role}`, true) as WorkspaceRoleRoute
      }
    }
    workspaceOverrides[workspaceKey] = result
  }

  const requireExplicitOwnership = bool(execution.requireExplicitOwnership, 'settings.execution.requireExplicitOwnership')
  if (requireExplicitOwnership !== true) throw new Error('settings.execution.requireExplicitOwnership is a security invariant and must be true')
  const trustedValidation = bool(review.trustedValidation, 'settings.review.trustedValidation')
  if (trustedValidation !== true) throw new Error('settings.review.trustedValidation is a security invariant and must be true')

  const parallelMode = execution.parallelMode
  if (!['auto', 'serial', 'worktree'].includes(String(parallelMode))) throw new Error('settings.execution.parallelMode invalid')

  return {
    enabled: bool(x.enabled, 'settings.enabled'),
    roles,
    planning: {
      adaptiveResearch: bool(planning.adaptiveResearch, 'settings.planning.adaptiveResearch'),
      strictReadOnly: bool(planning.strictReadOnly, 'settings.planning.strictReadOnly'),
      maxInitialReadFiles: integer(planning.maxInitialReadFiles, 'settings.planning.maxInitialReadFiles', 1, 32),
      softInputTokens: integer(planning.softInputTokens, 'settings.planning.softInputTokens', 1_000, 2_000_000),
      progressiveDiscovery: bool(planning.progressiveDiscovery, 'settings.planning.progressiveDiscovery'),
      requireExpansionReason: bool(planning.requireExpansionReason, 'settings.planning.requireExpansionReason'),
    },
    execution: {
      maxParallelWorkers: integer(execution.maxParallelWorkers, 'settings.execution.maxParallelWorkers', 1, 8),
      parallelMode: parallelMode as PlanSettings['execution']['parallelMode'],
      requireExplicitOwnership: true,
      keepFailedWorktrees: bool(execution.keepFailedWorktrees, 'settings.execution.keepFailedWorktrees'),
      sdkProfile: optionalString(execution.sdkProfile, 'settings.execution.sdkProfile', 128)!,
      roleTimeoutMs: integer(execution.roleTimeoutMs, 'settings.execution.roleTimeoutMs', 1_000, 3_600_000),
    },
    review: {
      maxReviewRounds: integer(review.maxReviewRounds, 'settings.review.maxReviewRounds', 0, 5),
      protocolRetry: integer(review.protocolRetry, 'settings.review.protocolRetry', 0, 1),
      trustedValidation: true,
      outputCapBytes: integer(review.outputCapBytes, 'settings.review.outputCapBytes', 1_024, 16 * 1024 * 1024),
    },
    recovery: { allowSafeResume: bool(recovery.allowSafeResume, 'settings.recovery.allowSafeResume') },
    externalIssue: {
      enabled: bool(externalIssue.enabled, 'settings.externalIssue.enabled'),
      publishAfterPass: bool(externalIssue.publishAfterPass, 'settings.externalIssue.publishAfterPass'),
    },
    workspaceOverrides,
  }
}

export function mergeSettings(base: PlanSettings, patch: Partial<PlanSettings>): PlanSettings {
  const roles = { ...base.roles, ...(patch.roles ?? {}) }
  const merged: PlanSettings = {
    ...base,
    ...patch,
    roles,
    planning: { ...base.planning, ...(patch.planning ?? {}) },
    execution: { ...base.execution, ...(patch.execution ?? {}) },
    review: { ...base.review, ...(patch.review ?? {}) },
    recovery: { ...base.recovery, ...(patch.recovery ?? {}) },
    externalIssue: { ...base.externalIssue, ...(patch.externalIssue ?? {}) },
    workspaceOverrides: { ...base.workspaceOverrides, ...(patch.workspaceOverrides ?? {}) },
  }
  return validateSettings(merged)
}

export function effectiveRoleRoute(settings: PlanSettings, role: RoleName, workspaceKey?: string): RoleRoute {
  const global = settings.roles[role]
  if (!workspaceKey) return structuredClone(global)
  const override = settings.workspaceOverrides[workspaceKey]?.roles?.[role]
  if (!override || override.mode === 'inherit') return structuredClone(global)
  return structuredClone({ ...override, mode: override.mode } as RoleRoute)
}
