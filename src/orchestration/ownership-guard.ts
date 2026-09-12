import { isAbsolute, relative, resolve, sep } from 'node:path'
import { normalizeOwnedPath, schedulerPathIdentity } from '../contract/plan-artifact.ts'

const FILE_MUTATORS = /^(?:write|write_file|edit|edit_file|delete|delete_file|move|move_file|rename|rename_file|mkdir|make_directory|apply_patch|patch)$/i
const PATH_KEYS = new Set(['path','file','filePath','file_path','target','destination','dest','to','source','src','from','newPath','new_path','oldPath','old_path'])

function patchPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    let match = /^\*\*\* (?:Update|Delete|Add) File:\s+(.+?)\s*$/.exec(line)
    if (!match) match = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+?)\s*$/.exec(line)
    const value = match?.[1]
    if (value && value !== '/dev/null') out.push(value)
  }
  return out
}

export function mutationTargetCandidates(toolName: string, args: unknown): string[] | undefined {
  if (!FILE_MUTATORS.test(toolName)) return undefined
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const record = args as Record<string, unknown>
  const found: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (PATH_KEYS.has(key)) {
      if (typeof value === 'string') found.push(value)
      else if (Array.isArray(value)) found.push(...value.filter((item): item is string => typeof item === 'string'))
    }
    if ((key === 'patch' || key === 'diff' || key === 'input') && typeof value === 'string') found.push(...patchPaths(value))
  }
  return [...new Set(found.filter(Boolean))]
}

export function toolPathToRepoRelative(root: string, raw: string): string {
  if (raw.includes('\0')) throw new Error('tool target contains NUL')
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  const rel = relative(resolve(root), absolute)
  if (!rel || rel === '.') throw new Error(`tool target is not an exact file: ${raw}`)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`tool target escapes repository: ${raw}`)
  return normalizeOwnedPath(rel.split(sep).join('/'))
}

export function ownershipGuardReason(root: string, allowed: string[], toolName: string, args: unknown): string | undefined {
  const candidates = mutationTargetCandidates(toolName, args)
  if (candidates === undefined) return undefined
  if (candidates.length === 0) return `Plan Orchestrator ownership guard cannot identify target path for mutating tool ${toolName}`
  const allowedSet = new Set(allowed.map(path => schedulerPathIdentity(path)))
  try {
    for (const raw of candidates) {
      const relativePath = toolPathToRepoRelative(root, raw)
      if (!allowedSet.has(schedulerPathIdentity(relativePath))) return `Plan Orchestrator ownership violation: ${relativePath}`
    }
  } catch (error) {
    return `Plan Orchestrator ownership violation: ${(error as Error).message}`
  }
  return undefined
}

/**
 * Install a monotonic guard before the one-shot child is created. A local
 * one-shot child records its direct parent in SessionHeader.parentSession, so
 * the guard can protect even the first tool call without waiting for start()
 * to return the child handle.
 */
export function installChildOwnershipGuard(ctx: any, parent: any, root: string, allowed: string[]): () => void {
  if (!ctx.tools?.guard) throw new Error('tools.guard unavailable for exact ownership enforcement')
  const parentId = String(parent.session.id)
  return ctx.tools.guard((exec: any) => {
    const agent = exec.agent
    if (!agent || String(agent.session?.header?.parentSession ?? '') !== parentId || agent.session?.header?.origin !== 'subagent') return undefined
    return ownershipGuardReason(root, allowed, String(exec.name ?? ''), exec.arguments)
  })
}
