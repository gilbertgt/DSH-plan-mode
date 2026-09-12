import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_SETTINGS,
  effectiveRoleRoute,
  mergeSettings,
  validateSettings,
  type PlanSettings,
  type RoleName,
  SETTINGS_NAMESPACE,
} from './contract/settings.ts'

const settingsEnvelope = z.any().default(DEFAULT_SETTINGS as any)

export function canonicalWorkspaceIdentity(cwd: string): string {
  let canonical = resolve(cwd)
  try { canonical = realpathSync.native(canonical) } catch {}
  if (process.platform === 'win32') canonical = canonical.toLocaleLowerCase('en-US')
  return canonical
}

export function workspaceKey(cwd: string): string {
  return createHash('sha256').update(canonicalWorkspaceIdentity(cwd)).digest('base64url')
}

export function registerSettings(ctx: any) {
  const handle = ctx.settings.register(SETTINGS_NAMESPACE, settingsEnvelope, {
    applies: 'live',
    validate: (value: unknown) => { validateSettings(value) },
  })
  const get = (): PlanSettings => validateSettings(handle.get() ?? DEFAULT_SETTINGS)
  const update = async (patch: Partial<PlanSettings>): Promise<void> => {
    const next = mergeSettings(get(), patch)
    await handle.update(next)
  }
  const effective = (cwd?: string): PlanSettings => {
    const value = get()
    if (!cwd) return value
    const key = workspaceKey(cwd)
    return {
      ...value,
      roles: Object.fromEntries((['planner', 'worker', 'integrator', 'reviewer'] as RoleName[])
        .map(role => [role, effectiveRoleRoute(value, role, key)])) as PlanSettings['roles'],
    }
  }
  return {
    get,
    effective,
    update,
    watch: (fn: (value: PlanSettings) => void) => handle.watch(() => fn(get())),
    writable: () => Boolean(ctx.settings.writable),
  }
}
