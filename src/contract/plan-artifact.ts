import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export interface PlanTask {
  id: string; title: string; objective: string; read: string[]; modify: string[]; decisionLocks: string[];
  requiredChanges: string[]; acceptanceCriteria: string[]; validation: string[]; dependsOn: string[]; parallelSafe: boolean
}
export interface ValidationCommand { id: string; taskIds: string[]; command: string; timeoutMs: number }
export interface PlanArtifact {
  planModeVersion: 1; summary: string; complexity: 'small'|'medium'|'large'; decisionLocks: string[]; tasks: PlanTask[];
  validationStrategy: string[]; validationCommands: ValidationCommand[]; risks: string[]; outOfScope: string[]
}
export interface ParsedValidationCommand {
  manager: 'npm'|'pnpm'|'yarn'|'bun'
  script: string
  args: string[]
}
const TOP = new Set(['planModeVersion','summary','complexity','decisionLocks','tasks','validationStrategy','validationCommands','risks','outOfScope'])
const TASK = new Set(['id','title','objective','read','modify','decisionLocks','requiredChanges','acceptanceCriteria','validation','dependsOn','parallelSafe'])
const VCMD = new Set(['id','taskIds','command','timeoutMs'])
const glob = /[*?\[\]{}!]/
const drive = /^[A-Za-z]:[\\/]/
const bytes = (s:string) => Buffer.byteLength(s, 'utf8')
const SAFE_VALIDATION_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/
const MANAGERS = new Set(['npm','pnpm','yarn','bun'])
const stringArray = (v:unknown, field:string): string[] => {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${field} must be a string array`)
  return [...v]
}
function strictKeys(value: Record<string, unknown>, allowed:Set<string>, where:string) {
  const unknown = Object.keys(value).filter(k => !allowed.has(k)); if (unknown.length) throw new Error(`${where} has unknown field(s): ${unknown.join(', ')}`)
}

/**
 * Validation is intentionally not an arbitrary shell surface. The Planner may
 * select an existing project package script, but it cannot inject redirection,
 * pipes, command substitution, inline interpreters, download-and-execute tools,
 * or an arbitrary executable into the host validation phase.
 */
export function parseValidationCommand(command:string): ParsedValidationCommand {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || bytes(command) > 2048) {
    throw new Error('validation command invalid')
  }
  const tokens = command.trim().split(/\s+/)
  if (tokens.some(token => !SAFE_VALIDATION_TOKEN.test(token))) {
    throw new Error('validation command may contain only conservative package-script tokens')
  }
  const rawManager = tokens.shift()!.toLowerCase()
  const manager = rawManager.replace(/\.(?:cmd|exe)$/i, '')
  if (!MANAGERS.has(manager)) throw new Error('validation command must use npm, pnpm, yarn, or bun package scripts')

  const action = tokens.shift()
  let script: string | undefined
  if (action === 'test') {
    if (manager === 'bun') throw new Error('bun validation must use bun run <script>; bun test is a direct runner, not a package script')
    script = 'test'
  } else if (action === 'run') script = tokens.shift()
  if (!script || !/^[A-Za-z0-9_.:@/-]{1,128}$/.test(script) || script === '.' || script === '..' || script.includes('../')) {
    throw new Error('validation command must select one existing package script')
  }

  let args: string[] = []
  if (tokens.length) {
    if (tokens[0] !== '--') throw new Error('validation command arguments must follow --')
    args = tokens.slice(1)
    if (args.some(arg => arg === '--' || !SAFE_VALIDATION_TOKEN.test(arg))) throw new Error('validation command arguments invalid')
  }
  return { manager: manager as ParsedValidationCommand['manager'], script, args }
}

export function normalizeOwnedPath(raw:string): string {
  if (!raw || raw.includes('\0') || raw.includes('\\')) throw new Error(`invalid owned path: ${JSON.stringify(raw)}`)
  if (raw.startsWith('/') || drive.test(raw) || glob.test(raw) || raw.endsWith('/')) throw new Error(`owned path must be an exact repository-relative file: ${raw}`)
  const normalized = posix.normalize(raw)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`owned path escapes repository: ${raw}`)
  if (normalized !== raw) throw new Error(`owned path must be canonical: ${raw}`)
  return normalized
}
export function schedulerPathIdentity(path:string, platform:NodeJS.Platform = process.platform):string {
  return platform === 'win32' || platform === 'darwin' ? path.toLocaleLowerCase('en-US') : path
}
export function runtimePathIdentity(path:string):string { return path }
export function validatePlanArtifact(input:unknown, requireExplicitOwnership=true): PlanArtifact {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PlanArtifact must be a JSON object')
  const x = input as Record<string, unknown>; strictKeys(x, TOP, 'PlanArtifact')
  if (x.planModeVersion !== 1) throw new Error('planModeVersion must equal 1')
  if (typeof x.summary !== 'string' || !x.summary.trim()) throw new Error('summary is required')
  if (!['small','medium','large'].includes(String(x.complexity))) throw new Error('invalid complexity')
  const decisionLocks = stringArray(x.decisionLocks, 'decisionLocks'), validationStrategy = stringArray(x.validationStrategy,'validationStrategy')
  const risks = stringArray(x.risks,'risks'), outOfScope = stringArray(x.outOfScope,'outOfScope')
  if (!Array.isArray(x.tasks) || x.tasks.length === 0) throw new Error('tasks must be non-empty')
  const ids = new Set<string>()
  const tasks: PlanTask[] = x.tasks.map((raw,i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`tasks[${i}] must be an object`)
    const t = raw as Record<string, unknown>; strictKeys(t,TASK,`tasks[${i}]`)
    for (const key of ['id','title','objective'] as const) if (typeof t[key] !== 'string' || !(t[key] as string).trim()) throw new Error(`tasks[${i}].${key} is required`)
    if (ids.has(t.id as string)) throw new Error(`duplicate task id: ${t.id}`); ids.add(t.id as string)
    const read = stringArray(t.read,`tasks[${i}].read`).map(normalizeOwnedPath)
    const modify = stringArray(t.modify,`tasks[${i}].modify`).map(normalizeOwnedPath)
    if (requireExplicitOwnership && modify.length === 0) throw new Error(`tasks[${i}].modify must be non-empty`)
    if (new Set(modify).size !== modify.length) throw new Error(`tasks[${i}].modify contains duplicates`)
    const acceptanceCriteria = stringArray(t.acceptanceCriteria,`tasks[${i}].acceptanceCriteria`); if (!acceptanceCriteria.length) throw new Error(`tasks[${i}].acceptanceCriteria must be non-empty`)
    if (typeof t.parallelSafe !== 'boolean') throw new Error(`tasks[${i}].parallelSafe must be boolean`)
    return { id:t.id as string,title:t.title as string,objective:t.objective as string,read,modify,decisionLocks:stringArray(t.decisionLocks,`tasks[${i}].decisionLocks`),requiredChanges:stringArray(t.requiredChanges,`tasks[${i}].requiredChanges`),acceptanceCriteria,validation:stringArray(t.validation,`tasks[${i}].validation`),dependsOn:stringArray(t.dependsOn,`tasks[${i}].dependsOn`),parallelSafe:t.parallelSafe }
  })
  for (const t of tasks) for (const dep of t.dependsOn) if (!ids.has(dep) || dep === t.id) throw new Error(`task ${t.id} has invalid dependency ${dep}`)
  assertAcyclic(tasks)
  if (!Array.isArray(x.validationCommands) || x.validationCommands.length > 4) throw new Error('validationCommands may contain at most 4 commands')
  const commandIds = new Set<string>()
  const validationCommands: ValidationCommand[] = x.validationCommands.map((raw,i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`validationCommands[${i}] must be object`)
    const c=raw as Record<string,unknown>; strictKeys(c,VCMD,`validationCommands[${i}]`)
    if (typeof c.id !== 'string' || !c.id.trim() || commandIds.has(c.id)) throw new Error(`invalid/duplicate validation command id`); commandIds.add(c.id)
    const taskIds=stringArray(c.taskIds,`validationCommands[${i}].taskIds`); if (!taskIds.length || taskIds.some(id=>!ids.has(id))) throw new Error(`validationCommands[${i}] references unknown task`)
    if (typeof c.command !== 'string' || !c.command.trim() || c.command.includes('\0') || bytes(c.command)>2048) throw new Error(`validationCommands[${i}].command invalid`)
    try { parseValidationCommand(c.command) } catch (error) { throw new Error(`validationCommands[${i}].command unsafe: ${(error as Error).message}`) }
    if (!Number.isSafeInteger(c.timeoutMs) || (c.timeoutMs as number)<1 || (c.timeoutMs as number)>600000) throw new Error(`validationCommands[${i}].timeoutMs invalid`)
    return {id:c.id as string, taskIds, command:c.command, timeoutMs:c.timeoutMs as number}
  })
  return { planModeVersion:1, summary:x.summary as string, complexity:x.complexity as PlanArtifact['complexity'], decisionLocks,tasks,validationStrategy,validationCommands,risks,outOfScope }
}
export function assertAcyclic(tasks:PlanTask[]) {
  const byId=new Map(tasks.map(t=>[t.id,t])); const state=new Map<string,number>()
  const visit=(id:string)=>{ const s=state.get(id)??0; if(s===1) throw new Error(`dependency cycle includes ${id}`); if(s===2)return; state.set(id,1); for(const d of byId.get(id)!.dependsOn)visit(d); state.set(id,2) }
  for(const t of tasks)visit(t.id)
}
export function extractPlanArtifact(markdown:string, requireExplicitOwnership=true): {artifact:PlanArtifact; hash:string} {
  const fences=[...markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)]
  if (fences.length !== 1) throw new Error(`plan markdown must contain exactly one JSON candidate fence; found ${fences.length}`)
  let parsed:unknown; try { parsed=JSON.parse(fences[0]![1]!) } catch(e) { throw new Error(`invalid PlanArtifact JSON: ${(e as Error).message}`) }
  const artifact=validatePlanArtifact(parsed, requireExplicitOwnership)
  const hash=createHash('sha256').update(JSON.stringify(artifact)).digest('hex')
  return {artifact,hash}
}
