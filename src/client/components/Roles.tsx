import React, { useEffect, useRef, useState } from 'react'
import {
  MAX_TOKENS_CEILING,
  effortState,
  isCustomMaxTokens,
  normalizeCapability,
  setMaxTokens,
  setModel,
  setProvider,
  setReasoningEffort,
  type ModelCapability,
} from '../role-route-ui.ts'

const roleNames = ['planner', 'worker', 'integrator', 'reviewer'] as const
type RoleName = typeof roleNames[number]

/** The Auto sentinel for the reasoning-effort select; never a stored value. */
const EFFORT_AUTO = ''

export function Roles({ settings, catalog, onRole, rpc, t }: any) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [capabilities, setCapabilities] = useState<Record<string, ModelCapability>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  // Keys with a request already in flight, so two roles sharing one
  // provider/model issue a single lookup instead of racing two identical ones.
  const inFlight = useRef<Set<string>>(new Set())

  const capabilityKey = (route: any): string =>
    route?.provider && route?.model ? `${route.provider}\u0000${route.model}` : ''

  const capabilityOf = (route: any): ModelCapability => {
    const key = capabilityKey(route)
    return key ? capabilities[key] ?? { efforts: [] } : { efforts: [] }
  }
  const isCapabilityLoading = (route: any): boolean => {
    const key = capabilityKey(route)
    return key ? loading[key] === true : false
  }

  useEffect(() => {
    for (const role of roleNames) {
      const route = settings?.roles?.[role]
      if (!route || route.mode !== 'fixed' || !route.provider || !route.model) continue
      const key = capabilityKey(route)
      if (capabilities[key] || inFlight.current.has(key)) continue
      inFlight.current.add(key)
      setLoading(state => ({ ...state, [key]: true }))
      void rpc('model-capability', { provider: route.provider, model: route.model })
        .then((raw: unknown) => {
          // A reply is discarded unless this card still shows the exact route it
          // was requested for, so a slow adapter answer for an abandoned model
          // can never populate a different model's options.
          if (capabilityKey(settings?.roles?.[role]) !== key) return
          setCapabilities(state => ({ ...state, [key]: normalizeCapability(raw) }))
        })
        .catch((error: any) => {
          if (capabilityKey(settings?.roles?.[role]) !== key) return
          setCapabilities(state => ({ ...state, [key]: { efforts: [], unavailable: error?.message ?? 'lookup failed' } }))
        })
        .finally(() => {
          inFlight.current.delete(key)
          setLoading(state => ({ ...state, [key]: false }))
        })
    }
    // Re-runs on any route change. `capabilities` and `loading` are deliberately
    // absent: they are only read as already-settled guards, and depending on them
    // would re-run this effect on every lookup settlement for no benefit.
  }, [settings, rpc])

  const validate = async (role: RoleName, route: any) => {
    if (route.mode !== 'fixed' || !route.provider || !route.model) {
      setErrors(state => ({ ...state, [role]: '' }))
      return
    }
    try {
      await rpc('route-validate', { route })
      setErrors(state => ({ ...state, [role]: '' }))
    } catch (error: any) {
      setErrors(state => ({ ...state, [role]: error.message }))
    }
  }

  return <div className="planx-grid">
    {roleNames.map(role => {
      const route = settings?.roles?.[role] ?? { mode: 'current', fallbacks: [] }
      const providers = (catalog ?? []).map((entry: any) => entry.provider)
      const models = (catalog ?? []).find((entry: any) => entry.provider.id === route.provider)?.models ?? []
      const capability = capabilityOf(route)
      const effort = effortState(route, capability)
      const custom = isCustomMaxTokens(route)
      const busy = isCapabilityLoading(route)
      const change = (next: any) => { onRole(role, next); void validate(role, next) }
      const fixed = route.mode === 'fixed'

      return <div className="planx-card" key={role}>
        <h3>{t('roles.' + role)}</h3>

        <label>{t('roles.mode')}
          <select value={route.mode} onChange={e => change(e.target.value === 'current'
            ? { mode: 'current', fallbacks: route.fallbacks ?? [] }
            : {
                // Fixed starts from a clean route: provider and model are chosen
                // next, and no control is carried over from another mode.
                mode: 'fixed',
                fallbacks: route.fallbacks ?? [],
                ...(route.provider ? { provider: route.provider } : {}),
                ...(route.model ? { model: route.model } : {}),
                ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
                ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
              })}>
            <option value="current">{t('roles.modeCurrent')}</option>
            <option value="fixed">{t('roles.modeFixed')}</option>
          </select>
        </label>

        {fixed && <>
          <label>{t('roles.provider')}
            <select value={route.provider ?? ''} onChange={e => change(setProvider(route, e.target.value))}>
              <option value="">{t('common.select')}</option>
              {providers.map((provider: any) => <option key={provider.id} value={provider.id}>{provider.name ?? provider.id}</option>)}
            </select>
          </label>

          <label>{t('roles.model')}
            <select value={route.model ?? ''} onChange={e => change(setModel(route, e.target.value))}>
              <option value="">{t('common.select')}</option>
              {models.map((model: any) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
            </select>
          </label>

          <label>{t('roles.effort')}
            <select
              value={effort.value}
              disabled={busy || effort.disabled}
              onChange={e => change(setReasoningEffort(route, e.target.value === EFFORT_AUTO ? undefined : e.target.value))}>
              <option value={EFFORT_AUTO}>{t('roles.effortAuto')}</option>
              {effort.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              {/* A stored effort this model does not report stays visible and selectable. */}
              {effort.legacy && <option value={effort.value}>{effort.value}</option>}
            </select>
          </label>
          {busy && <p className="planx-muted">{t('roles.capabilityLoading')}</p>}
          {!busy && capability.unavailable && <p className="planx-muted">{t('roles.capabilityUnavailable', { reason: capability.unavailable })}</p>}
          {!busy && !capability.unavailable && effort.options.length === 0 && <p className="planx-muted">{t('roles.effortDisabled')}</p>}
          {effort.legacy && <p className="planx-error" role="alert">{t('roles.legacyEffort', { value: effort.value })}</p>}

          <label>{t('roles.maxTokens')}
            <select
              value={custom ? 'custom' : 'auto'}
              aria-label={t('roles.maxTokens')}
              onChange={e => change(e.target.value === 'custom'
                // Custom starts from the adapter's per-request default when one is
                // known, otherwise from the lowest value the contract accepts.
                ? setMaxTokens(route, capability.defaultMaxTokens ?? 1)
                : setMaxTokens(route, undefined))}>
              <option value="auto">{t('roles.maxTokensAuto')}</option>
              <option value="custom">{t('roles.maxTokensCustom')}</option>
            </select>
          </label>
          {custom && <label>{t('roles.maxTokensCustom')}
            <input
              type="number"
              min={1}
              max={MAX_TOKENS_CEILING}
              value={route.maxTokens ?? ''}
              onBlur={() => void validate(role, route)}
              onChange={e => change(setMaxTokens(route, e.target.value ? Number(e.target.value) : undefined))}
            />
          </label>}
          {/* The adapter's per-request default is information, not a ceiling. */}
          {!custom && capability.defaultMaxTokens !== undefined && <p className="planx-muted">{t('roles.defaultMaxTokens', { value: capability.defaultMaxTokens })}</p>}

          {!route.provider || !route.model ? <p className="planx-muted">{t('roles.incomplete')}</p> : null}
        </>}

        {errors[role] && <div className="planx-error" role="alert">{errors[role]}</div>}
        <p className="planx-muted">{t('roles.fallbacksNote')}</p>
      </div>
    })}
  </div>
}
