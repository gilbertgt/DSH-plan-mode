import { validatePlanArtifact, type PlanArtifact } from '../contract/plan-artifact.ts'
export interface ExternalPlanMeta{version:1;revision:number;repository:string;baseCommit:string}
export interface ExternalContract{externalPlan:ExternalPlanMeta;plan:PlanArtifact}
export interface CompletionEvidence{externalCompletion:{version:1;revision:number;repository:string;issue:number;pr:number;head:string}}
function meta(value:any):ExternalPlanMeta{
  const e=value?.externalPlan
  if(!e||e.version!==1||!Number.isSafeInteger(e.revision)||e.revision<1||typeof e.repository!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(e.repository)||typeof e.baseCommit!=='string'||!/^[0-9a-f]{40}$/.test(e.baseCommit))throw new Error('invalid externalPlan metadata')
  return{version:1,revision:e.revision,repository:e.repository,baseCommit:e.baseCommit}
}
export function validateExternalContract(value:any):ExternalContract{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('external contract object required')
  const externalPlan=meta(value)
  let planInput:any
  if(value.plan&&typeof value.plan==='object')planInput=value.plan
  else{const {externalPlan:_ignored,...rest}=value;planInput=rest}
  return{externalPlan,plan:validatePlanArtifact(planInput,true)}
}
function canonical(value:any):string{if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;return JSON.stringify(value)}
export function selectTrustedRevision(contracts:ExternalContract[]){
  if(!contracts.length)throw new Error('no valid external contract')
  const max=Math.max(...contracts.map(c=>c.externalPlan.revision)),same=contracts.filter(c=>c.externalPlan.revision===max)
  const normalized=new Set(same.map(c=>canonical(c)))
  if(normalized.size!==1)throw new Error(`conflicting contracts at revision ${max}`)
  return same[0]!
}
export function extractExternalContracts(text:string){
  const out:ExternalContract[]=[]
  for(const m of text.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)){try{out.push(validateExternalContract(JSON.parse(m[1]!)))}catch{}}
  return out
}
export function validateCompletionEvidence(value:any):CompletionEvidence{
  const e=value?.externalCompletion
  if(!e||e.version!==1||!Number.isSafeInteger(e.revision)||e.revision<1||typeof e.repository!=='string'||!Number.isSafeInteger(e.issue)||e.issue<1||!Number.isSafeInteger(e.pr)||e.pr<1||typeof e.head!=='string'||!/^[0-9a-f]{40}$/.test(e.head))throw new Error('invalid external completion evidence')
  return{externalCompletion:{version:1,revision:e.revision,repository:e.repository,issue:e.issue,pr:e.pr,head:e.head}}
}
export function extractCompletionEvidence(text:string){
  if(!text.includes('IMPLEMENTATION COMPLETE'))return[] as CompletionEvidence[]
  const out:CompletionEvidence[]=[]
  for(const m of text.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)){try{out.push(validateCompletionEvidence(JSON.parse(m[1]!)))}catch{}}
  return out
}
