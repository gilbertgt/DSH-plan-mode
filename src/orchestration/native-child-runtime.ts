import { resolve } from 'node:path'

const NESTED_DELEGATION_TOOL = /^(?:subagent(?:_|$)|send_message$|interrupt_agent$|list_agents$|workflow$|ralph$)/i

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function nativeChildRuntimeGuardReason(root: string, agent: any, toolName: string): string | undefined {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return 'Plan Orchestrator worktree binding violation: child cwd is unavailable'
  }
  if (!samePath(cwd, root)) {
    return `Plan Orchestrator worktree binding violation: child cwd ${cwd} != ${root}`
  }
  if (NESTED_DELEGATION_TOOL.test(toolName)) {
    return `Plan Orchestrator leaf-role policy: nested delegation/control tool is forbidden: ${toolName}`
  }
  return undefined
}

/**
 * Native Worker/Integrator roles are leaf executors. Install this before the
 * child is created so even its first tool call is fenced to the exact Plan
 * worktree and cannot start background/nested agent work that may outlive the
 * one-shot parent role.
 */
export function installNativeChildRuntimeGuard(ctx: any, parent: any, root: string): () => void {
  if (!ctx.tools?.guard) throw new Error('tools.guard unavailable for native child runtime policy')
  if (!parent?.session?.id) throw new Error('parent session unavailable for native child runtime policy')
  const parentId = String(parent.session.id)
  return ctx.tools.guard((exec: any) => {
    const agent = exec.agent
    if (!agent || String(agent.session?.header?.parentSession ?? '') !== parentId || agent.session?.header?.origin !== 'subagent') return undefined
    return nativeChildRuntimeGuardReason(root, agent, String(exec.name ?? ''))
  })
}
