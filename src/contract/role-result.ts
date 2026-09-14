export interface RoleValidation { id: string; status: 'PASS'|'FAIL'|'INCONCLUSIVE'; detail?: string }
export interface RoleResult { taskId: string; status: 'COMPLETE'|'BLOCKED'|'FAILED'; changed: string[]; validation: RoleValidation[]; remaining: string[]; contextExpansion: string[] }

/**
 * Model-facing structured-output schema. DeepSeek Harness intentionally accepts
 * only a constrained raw JSON Schema vocabulary for subagent outputSchema.
 * Size/count limits therefore stay in validateRoleResult(), where they are
 * enforced after structured output is returned instead of being expressed with
 * unsupported maxLength/maxItems keywords here.
 */
export const ROLE_RESULT_SCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    taskId:{type:'string'}, status:{type:'string',enum:['COMPLETE','BLOCKED','FAILED']},
    changed:{type:'array',items:{type:'string'}},
    validation:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},status:{type:'string',enum:['PASS','FAIL','INCONCLUSIVE']},detail:{type:'string'}},required:['id','status']}},
    remaining:{type:'array',items:{type:'string'}}, contextExpansion:{type:'array',items:{type:'string'}},
  }, required:['taskId','status','changed','validation','remaining','contextExpansion'],
} as const
const KEYS=new Set(['taskId','status','changed','validation','remaining','contextExpansion'])
const VKEYS=new Set(['id','status','detail'])

/** Marker appended when one diagnostic string is clipped to its ceiling. */
const TRUNCATION_MARKER = '…[truncated by host]'
/**
 * Per-string ceiling for informational text (remaining work, context
 * expansion, validation detail).
 *
 * Shape and type violations still fail closed: a non-string, an over-long list,
 * or an unknown field is abuse and is rejected. Length alone is different. These
 * fields carry the Worker's own blocker explanation — the exact text that makes
 * a BLOCKED run diagnosable — and a real explanation routinely exceeds a tight
 * per-string cap (an observed case was a 1169-character blocker note against a
 * 1000-character limit). Rejecting the whole result over that turned a precise
 * BLOCKED report into the opaque `remaining invalid`, discarding the diagnosis
 * and failing the run. The total 128KiB envelope below remains the real
 * fail-closed bound on payload size.
 */
const DIAGNOSTIC_MAX_CHARS = 4000

/**
 * Validate one informational string array.
 *
 * @throws when the value is not an array, exceeds `maxItems`, or holds a
 * non-string element — structural violations, never mere length.
 */
function boundedStrings(value:unknown,name:string,maxItems:number,maxChars:number,truncate=false):string[]{
  if(!Array.isArray(value)||value.length>maxItems)throw new Error(`${name} invalid`)
  return value.map(item=>{
    if(typeof item!=='string'||(!truncate&&item.length>maxChars))throw new Error(`${name} invalid`)
    return truncate&&item.length>maxChars?`${item.slice(0,maxChars)}${TRUNCATION_MARKER}`:item
  })
}

export function validateRoleResult(value:unknown, taskId:string): RoleResult {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('role result must be an object')
  const x=value as Record<string,unknown>;const unknown=Object.keys(x).filter(k=>!KEYS.has(k));if(unknown.length)throw new Error(`role result unknown fields: ${unknown.join(', ')}`)
  let rawEncoded:string
  try{rawEncoded=JSON.stringify(value)}catch{throw new Error('role result must be JSON-serializable')}
  if(Buffer.byteLength(rawEncoded,'utf8')>128*1024)throw new Error('role result exceeds 128KiB')
  if(x.taskId!==taskId||typeof x.taskId!=='string'||x.taskId.length>200) throw new Error('role taskId mismatch')
  if(!['COMPLETE','BLOCKED','FAILED'].includes(String(x.status))) throw new Error('role status invalid')
  const changed=boundedStrings(x.changed,'changed',200,512)
  const remaining=boundedStrings(x.remaining,'remaining',30,DIAGNOSTIC_MAX_CHARS,true)
  const contextExpansion=boundedStrings(x.contextExpansion,'contextExpansion',30,DIAGNOSTIC_MAX_CHARS,true)
  if(!Array.isArray(x.validation)||x.validation.length>30)throw new Error('validation invalid')
  const validation:RoleValidation[]=x.validation.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('validation invalid')
    const v=item as Record<string,unknown>
    if(Object.keys(v).some(k=>!VKEYS.has(k))||typeof v.id!=='string'||v.id.length>200||!['PASS','FAIL','INCONCLUSIVE'].includes(String(v.status)))throw new Error('validation invalid')
    if(v.detail===undefined)return{id:v.id,status:v.status as RoleValidation['status']}
    if(typeof v.detail!=='string')throw new Error('validation invalid')
    const detail=v.detail.length>DIAGNOSTIC_MAX_CHARS?`${v.detail.slice(0,DIAGNOSTIC_MAX_CHARS)}${TRUNCATION_MARKER}`:v.detail
    return{id:v.id,status:v.status as RoleValidation['status'],detail}
  })
  // The normalized result — not the raw input — is returned, so a clipped string
  // is what callers actually observe and record.
  const result:RoleResult={taskId:x.taskId,status:x.status as RoleResult['status'],changed,validation,remaining,contextExpansion}
  const encoded=JSON.stringify(result); if(Buffer.byteLength(encoded,'utf8')>128*1024) throw new Error('role result exceeds 128KiB')
  return result
}
