export interface RoleValidation { id: string; status: 'PASS'|'FAIL'|'INCONCLUSIVE'; detail?: string }
export interface RoleResult { taskId: string; status: 'COMPLETE'|'BLOCKED'|'FAILED'; changed: string[]; validation: RoleValidation[]; remaining: string[]; contextExpansion: string[] }
export const ROLE_RESULT_SCHEMA = {
  type:'object', additionalProperties:false,
  properties:{
    taskId:{type:'string',maxLength:200}, status:{type:'string',enum:['COMPLETE','BLOCKED','FAILED']},
    changed:{type:'array',items:{type:'string',maxLength:512},maxItems:200},
    validation:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string',maxLength:200},status:{type:'string',enum:['PASS','FAIL','INCONCLUSIVE']},detail:{type:'string',maxLength:2000}},required:['id','status']},maxItems:30},
    remaining:{type:'array',items:{type:'string',maxLength:1000},maxItems:30}, contextExpansion:{type:'array',items:{type:'string',maxLength:1000},maxItems:30},
  }, required:['taskId','status','changed','validation','remaining','contextExpansion'],
} as const
const KEYS=new Set(['taskId','status','changed','validation','remaining','contextExpansion'])
const VKEYS=new Set(['id','status','detail'])
function boundedStrings(value:unknown,name:string,maxItems:number,maxChars:number){if(!Array.isArray(value)||value.length>maxItems)throw new Error(`${name} invalid`);for(const item of value)if(typeof item!=='string'||item.length>maxChars)throw new Error(`${name} invalid`);return value as string[]}
export function validateRoleResult(value:unknown, taskId:string): RoleResult {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('role result must be an object')
  const x=value as Record<string,unknown>;const unknown=Object.keys(x).filter(k=>!KEYS.has(k));if(unknown.length)throw new Error(`role result unknown fields: ${unknown.join(', ')}`)
  if(x.taskId!==taskId||typeof x.taskId!=='string'||x.taskId.length>200) throw new Error('role taskId mismatch')
  if(!['COMPLETE','BLOCKED','FAILED'].includes(String(x.status))) throw new Error('role status invalid')
  boundedStrings(x.changed,'changed',200,512);boundedStrings(x.remaining,'remaining',30,1000);boundedStrings(x.contextExpansion,'contextExpansion',30,1000)
  if(!Array.isArray(x.validation)||x.validation.length>30)throw new Error('validation invalid')
  for(const item of x.validation){if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('validation invalid');const v=item as Record<string,unknown>;if(Object.keys(v).some(k=>!VKEYS.has(k))||typeof v.id!=='string'||v.id.length>200||!['PASS','FAIL','INCONCLUSIVE'].includes(String(v.status))||(v.detail!==undefined&&(typeof v.detail!=='string'||v.detail.length>2000)))throw new Error('validation invalid')}
  const encoded=JSON.stringify(value); if(Buffer.byteLength(encoded,'utf8')>128*1024) throw new Error('role result exceeds 128KiB')
  return value as RoleResult
}
