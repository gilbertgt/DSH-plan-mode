import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

const NATIVE_MUTATING_CHILD = Symbol('plan-orchestrator:native-mutating-child')

export interface NativeMutatingChildSandboxScope {
  mark<T extends object>(options: T): T
  dispose(): void
}

/**
 * Arm one exact Native Worker/Integrator delegation. DSH snapshots the parent's
 * explicit sandbox override before creating an in-process child, so a strict
 * read-only Plan parent would otherwise create a read-only mutating child.
 *
 * The call-scoped token prevents concurrent delegations from matching each
 * other's `agent/created` events. The child receives a later workspace-write
 * session override during its unpublished creation window; the parent and all
 * unmarked children (including Reviewer children) remain untouched. Delegated
 * approval is still owned by DSH and remains pinned to `never`.
 */
export function installNativeMutatingChildSandbox(ctx: any): NativeMutatingChildSandboxScope {
  if (typeof ctx?.on !== 'function') throw new Error('ctx.on unavailable for native mutating child sandbox policy')

  const token = Object.freeze({})
  let disposed = false
  const release = ctx.on('agent/created', ({ agent }: any) => {
    if (agent?.options?.[NATIVE_MUTATING_CHILD] !== token) return
    setSandboxMode(agent.session, 'workspace-write')
  })

  return {
    mark<T extends object>(options: T): T {
      if (disposed) throw new Error('native mutating child sandbox scope already disposed')
      return { ...options, [NATIVE_MUTATING_CHILD]: token }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      release()
    },
  }
}
