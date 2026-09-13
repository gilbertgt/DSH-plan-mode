/**
 * Pure route and capability transitions for the Plan Mode role-model UI.
 *
 * This module owns the one rule the settings contract cares about most: an
 * optional route control is either a real value or an *absent* property. DSH's
 * lossless-JSON boundaries reject an explicitly `undefined` property, so every
 * transition here rebuilds the route object instead of spreading a possibly
 * `undefined` value into it — "Auto" is expressed by omission, never by
 * `undefined` and never by an empty string.
 *
 * It deliberately imports types only, holds no React and no user-visible text,
 * so both the client bundle and the Node test runner can load it unchanged.
 */
import type { RouteChoice, RoleRoute } from '../contract/settings.ts'
import type { RunPhase } from '../contract/events.ts'

/** Every run phase, in lifecycle order; keys into the `phase.*` dictionary. */
export const RUN_PHASES = [
  'IDLE', 'PLANNING', 'PLAN_VALIDATED', 'APPROVED_PENDING', 'PREFLIGHT', 'WORKERS',
  'INTEGRATING', 'VALIDATING', 'REVIEWING', 'FIXING', 'COMPLETE', 'BLOCKED',
  'FAILED', 'INTERRUPTED', 'CANCELLED',
] as const satisfies readonly RunPhase[]

/**
 * Contract hard ceiling for a custom maxTokens entry.
 *
 * Mirrors `settings.maxTokens` validation (`1..2_000_000`). It is a settings
 * contract bound, explicitly *not* a claim about any model's output limit.
 */
export const MAX_TOKENS_CEILING = 2_000_000

const PHASE_KEYS = new Set<string>(RUN_PHASES)

/**
 * Render one run phase through the dictionary.
 *
 * A phase this build does not know (a newer DSH, or a corrupted projection
 * value) falls back to the raw identifier so the UI shows `SOMETHING_NEW`
 * rather than a missing-key placeholder. Phase identifiers are data and are
 * never translated; only the display label is.
 */
export function phaseLabel(t: (key: string) => string, phase: unknown): string {
  const raw = typeof phase === 'string' ? phase : ''
  if (PHASE_KEYS.has(raw)) return t(`phase.${raw}`)
  return raw
}

/**
 * Rebuild a route carrying exactly the provided optional controls.
 *
 * A control that is absent from `controls`, or that holds `undefined`, is not
 * copied — so the result can never carry a property whose value is `undefined`.
 * Callers pass only the controls that should survive, which is how "Auto" is
 * expressed.
 */
function rebuild(route: RoleRoute, controls: Partial<RouteChoice>): RoleRoute {
  const next: Record<string, unknown> = { mode: route.mode, fallbacks: route.fallbacks ?? [] }
  for (const [key, value] of Object.entries(controls)) {
    if (value !== undefined && value !== null) next[key] = value
  }
  return next as unknown as RoleRoute
}

/**
 * Select a provider: the previous provider's model and every model-specific
 * control are dropped, because they describe a route that no longer exists.
 */
export function setProvider(route: RoleRoute, provider: string): RoleRoute {
  return rebuild(route, { provider })
}

/**
 * Select a model within the current provider. Reasoning effort and maxTokens
 * are dropped: both are capabilities of the exact model, so carrying them over
 * would silently apply one model's control to another.
 */
export function setModel(route: RoleRoute, model: string): RoleRoute {
  return rebuild(route, { provider: route.provider, model })
}

/** Set the reasoning effort, or omit it for "Auto (provider decides)". */
export function setReasoningEffort(route: RoleRoute, effort: string | undefined): RoleRoute {
  return rebuild(route, {
    provider: route.provider,
    model: route.model,
    reasoningEffort: effort,
    maxTokens: route.maxTokens,
  })
}

/**
 * Set maxTokens, or omit it for "Auto (use the DSH / provider default)".
 *
 * A value outside the settings contract (`1..MAX_TOKENS_CEILING`) is refused
 * rather than stored: committing it would build a route the authoritative
 * validator rejects, which is worse than falling back to Auto. The value is
 * dropped, never coerced, so the stored route is either a real number the
 * contract accepts or no property at all.
 */
export function setMaxTokens(route: RoleRoute, maxTokens: number | undefined): RoleRoute {
  const usable = typeof maxTokens === 'number'
    && Number.isSafeInteger(maxTokens)
    && maxTokens >= 1
    && maxTokens <= MAX_TOKENS_CEILING
  const controls: Partial<RouteChoice> = { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
  // Auto omits the key entirely rather than passing an undefined value.
  if (usable) controls.maxTokens = maxTokens
  return rebuild(route, controls)
}

/** One adapter-owned reasoning level offered for an exact provider/model route. */
export interface EffortOption {
  /** Opaque adapter-owned id sent back as the route's `reasoningEffort`. */
  id: string
  /** Adapter-supplied display name; never translated by this plugin. */
  name: string
  description?: string
}

/**
 * Normalized capability for one exact provider/model route.
 *
 * There is deliberately no `maxTokens` field: rc.1 exposes no authoritative
 * per-model *limit*, and `defaultMaxTokens` is an adapter-configured per-request
 * default that is materialized only when the caller omits one. Presenting it as
 * a ceiling would invent a capability the host never declared.
 */
export interface ModelCapability {
  efforts: EffortOption[]
  defaultEffort?: string
  /** Adapter-configured per-request output default; informational only. */
  defaultMaxTokens?: number
  /** Combined request+response context window, when the adapter discloses one. */
  contextWindow?: number
  /** Set when capability could not be read; `efforts` is then empty. */
  unavailable?: string
}

/**
 * A fresh empty capability.
 *
 * This is a factory rather than a shared constant on purpose: `efforts` is a
 * mutable array, so spreading one shared object would hand every caller the same
 * array and let one model's efforts accumulate into the next model's options —
 * exactly the cross-model leakage this module exists to prevent.
 */
function emptyCapability(): ModelCapability {
  return { efforts: [] }
}

/**
 * Normalize a `resolveModelInfo` result (or the RPC envelope carrying one) into
 * the UI contract.
 *
 * Anything unrecognised collapses to "no capability" rather than to a guessed
 * option list: a malformed or absent payload must never become a fabricated
 * model capability.
 */
export function normalizeCapability(raw: unknown): ModelCapability {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCapability()
  const value = raw as Record<string, unknown>
  if (typeof value.unavailable === 'string' && value.unavailable.length > 0) {
    return { ...emptyCapability(), unavailable: value.unavailable }
  }
  const cap = emptyCapability()
  const reasoning = value.reasoning
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const effortsRaw = (reasoning as Record<string, unknown>).efforts
    if (Array.isArray(effortsRaw)) {
      for (const item of effortsRaw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const effort = item as Record<string, unknown>
        if (typeof effort.id !== 'string' || effort.id.length === 0) continue
        if (typeof effort.name !== 'string' || effort.name.length === 0) continue
        if (cap.efforts.some(existing => existing.id === effort.id)) continue
        cap.efforts.push({
          id: effort.id,
          name: effort.name,
          ...(typeof effort.description === 'string' && effort.description.length > 0
            ? { description: effort.description }
            : {}),
        })
      }
    }
    const defaultEffort = (reasoning as Record<string, unknown>).defaultEffort
    if (typeof defaultEffort === 'string' && cap.efforts.some(effort => effort.id === defaultEffort)) {
      cap.defaultEffort = defaultEffort
    }
  }
  if (typeof value.defaultMaxTokens === 'number' && Number.isSafeInteger(value.defaultMaxTokens) && value.defaultMaxTokens > 0) {
    cap.defaultMaxTokens = value.defaultMaxTokens
  }
  if (typeof value.contextWindow === 'number' && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0) {
    cap.contextWindow = value.contextWindow
  }
  return cap
}

/** Rendering state of the two dependent controls for one role card. */
export interface EffortControlState {
  /** Selectable efforts, in adapter order; empty when the model exposes none. */
  options: EffortOption[]
  /** Current effort value to display, including one the capability does not offer. */
  value: string
  /**
   * True when `value` is a stored effort this model does not report. The UI must
   * show it verbatim and warn, never silently rewrite or drop it.
   */
  legacy: boolean
  /** True when the select must be disabled (no options, or Auto only). */
  disabled: boolean
}

/**
 * Decide what the reasoning-effort select shows for one route.
 *
 * A stored value that the capability does not list is preserved and flagged:
 * the settings contract still holds it, and only the user may change it.
 */
export function effortState(route: RoleRoute, capability: ModelCapability): EffortControlState {
  const value = typeof route.reasoningEffort === 'string' ? route.reasoningEffort : ''
  const options = capability.efforts
  const legacy = value !== '' && !options.some(option => option.id === value)
  // Disabled only when there is genuinely nothing to choose: no offered effort
  // and no stored value. A stored value the model does not report keeps the
  // control enabled so the user can still switch it back to Auto.
  return { options, value, legacy, disabled: options.length === 0 && value === '' }
}

/** Whether the maxTokens control is in Custom mode (a stored number exists). */
export function isCustomMaxTokens(route: RoleRoute): boolean {
  return typeof route.maxTokens === 'number' && Number.isSafeInteger(route.maxTokens) && route.maxTokens >= 1
}
