import type { PlanArtifact, PlanTask } from '../contract/plan-artifact.ts';import { disjointOwnership } from '../git/ownership.ts'
export interface ExecutionWave{mode:'serial'|'parallel';taskIds:string[]}
export function buildWaves(plan:PlanArtifact, maxParallel=3, mode:'auto'|'serial'|'worktree'='auto', platform:NodeJS.Platform=process.platform):ExecutionWave[]{
 const tasks=new Map(plan.tasks.map(t=>[t.id,t]));const done=new Set<string>(),remaining=new Set(plan.tasks.map(t=>t.id)),waves:ExecutionWave[]=[]
 while(remaining.size){const ready=plan.tasks.filter(t=>remaining.has(t.id)&&t.dependsOn.every(d=>done.has(d)));if(!ready.length)throw new Error('scheduler deadlock')
  if(mode!=='serial'&&maxParallel>1){const candidates=ready.filter(t=>t.parallelSafe);const selected:PlanTask[]=[];for(const t of candidates){if(selected.length>=maxParallel)break;if(selected.every(s=>disjointOwnership(s.modify,t.modify,platform)))selected.push(t)}if(selected.length>=2){const ids=selected.map(t=>t.id);waves.push({mode:'parallel',taskIds:ids});for(const id of ids){remaining.delete(id);done.add(id)};continue}}
  const t=ready[0]!;waves.push({mode:'serial',taskIds:[t.id]});remaining.delete(t.id);done.add(t.id)
 }
 return waves
}
export function recheckWave(plan:PlanArtifact,wave:ExecutionWave,platform:NodeJS.Platform=process.platform){if(wave.mode==='serial')return true;const tasks=wave.taskIds.map(id=>plan.tasks.find(t=>t.id===id)!);return tasks.length>=2&&tasks.every(t=>t.parallelSafe)&&tasks.every((t,i)=>tasks.slice(i+1).every(o=>disjointOwnership(t.modify,o.modify,platform)))&&tasks.every(t=>t.dependsOn.every(d=>!wave.taskIds.includes(d)))}
