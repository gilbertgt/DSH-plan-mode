export type RunPhase = 'IDLE'|'PLANNING'|'PLAN_VALIDATED'|'APPROVED_PENDING'|'PREFLIGHT'|'WORKERS'|'INTEGRATING'|'VALIDATING'|'REVIEWING'|'FIXING'|'COMPLETE'|'BLOCKED'|'FAILED'|'INTERRUPTED'|'CANCELLED'
export interface RunProjection { runId:string; sessionId:string; phase:RunPhase; status:string; tasksTotal:number; tasksDone:number; activeTaskIds:string[]; reviewRound:number; message?:string; startedAt:string; updatedAt:string }
export type PlanxEvent =
  | {type:'planx/run-approved'; data:{runId:string; sessionId:string; planHash:string; tasksTotal:number; at:string}}
  | {type:'planx/run-phase'; data:{runId:string; phase:RunPhase; message?:string; at:string}}
  | {type:'planx/task-start'; data:{runId:string; taskId:string; at:string}}
  | {type:'planx/task-end'; data:{runId:string; taskId:string; status:string; at:string}}
  | {type:'planx/validation'; data:{runId:string; commandId:string; status:string; at:string}}
  | {type:'planx/review'; data:{runId:string; round:number; verdict:string; at:string}}
  | {type:'planx/recovery'; data:{runId:string; status:string; message?:string; at:string}}
  | {type:'planx/run-terminal'; data:{runId:string; phase:'COMPLETE'|'BLOCKED'|'FAILED'|'INTERRUPTED'|'CANCELLED'; message?:string; at:string}}

export function isPlanxEvent(event:any):event is PlanxEvent{return Boolean(event&&typeof event.type==='string'&&event.type.startsWith('planx/')&&event.data&&typeof event.data.runId==='string')}

/**
 * Reject a session event payload that JSON cannot carry losslessly.
 *
 * DSH `Session.append` snapshots `data` through the lossless-JSON validator and
 * throws on an explicitly `undefined` property (absent is fine, `undefined` is
 * not). An optional field must therefore be omitted rather than assigned
 * `undefined`. Failing here names the offending path instead of surfacing an
 * opaque append rejection.
 */
export function assertLosslessEventData(value:unknown,label:string):void{
  const seen=new Set<object>()
  const walk=(node:unknown,path:string):void=>{
    if(node===undefined)throw new Error(`${label} carries an undefined value at ${path}; omit the optional property instead`)
    if(typeof node==='number'&&!Number.isFinite(node))throw new Error(`${label} carries a non-finite number at ${path}`)
    if(typeof node==='bigint'||typeof node==='function'||typeof node==='symbol')throw new Error(`${label} carries a non-JSON ${typeof node} at ${path}`)
    if(typeof node!=='object'||node===null)return
    if(seen.has(node))throw new Error(`${label} carries a circular reference at ${path}`)
    seen.add(node)
    if(Array.isArray(node)){node.forEach((item,index)=>walk(item,`${path}[${index}]`))}
    else{
      const prototype=Object.getPrototypeOf(node)
      if(prototype!==Object.prototype&&prototype!==null)throw new Error(`${label} carries a non-plain object at ${path}`)
      for(const [key,item] of Object.entries(node))walk(item,`${path}.${key}`)
    }
    seen.delete(node)
  }
  walk(value,label)
}
export function reducePlanxEvents(sessionId:string, events:readonly any[]):RunProjection[]{
  const rows=new Map<string,RunProjection>()
  for(const event of events){if(!isPlanxEvent(event))continue;const d:any=event.data;let v=rows.get(d.runId)
    if(event.type==='planx/run-approved'){v={runId:d.runId,sessionId:String(d.sessionId??sessionId),phase:'APPROVED_PENDING',status:'APPROVED_PENDING',tasksTotal:d.tasksTotal,tasksDone:0,activeTaskIds:[],reviewRound:0,startedAt:d.at,updatedAt:d.at};rows.set(d.runId,v);continue}
    if(!v)continue
    if(event.type==='planx/run-phase'){v.phase=d.phase;v.status=d.phase;if(d.message)v.message=d.message}
    else if(event.type==='planx/task-start'){if(!v.activeTaskIds.includes(d.taskId))v.activeTaskIds.push(d.taskId)}
    else if(event.type==='planx/task-end'){v.activeTaskIds=v.activeTaskIds.filter(x=>x!==d.taskId);v.tasksDone=Math.min(v.tasksTotal,v.tasksDone+1)}
    else if(event.type==='planx/review'){v.reviewRound=d.round}
    else if(event.type==='planx/recovery'){v.status=d.status;if(d.message)v.message=d.message}
    else if(event.type==='planx/run-terminal'){v.phase=d.phase;v.status=d.phase;v.activeTaskIds=[];if(d.message)v.message=d.message}
    v.updatedAt=d.at
  }
  return [...rows.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
}
