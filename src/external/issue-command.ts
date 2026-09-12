import { createHash } from 'node:crypto'
import { extractCompletionEvidence, extractExternalContracts, selectTrustedRevision } from './contract.ts'
import { fetchIssue, ghPreflight, prepareIssueBranch, remotePr } from './github.ts'
import { findCurrentCompletion } from './continuation.ts'

export function parseIssueCommand(text:string){
  let m=/^\/plan-issue\s+(\d+)\s*$/.exec(text)
  if(!m)m=/^(?:完成 Issue #|complete issue #)(\d+)\s*$/i.exec(text)
  if(!m)return undefined
  const n=Number(m[1])
  return Number.isSafeInteger(n)&&n>0?n:undefined
}
export function parseIssueInput(raw:string){
  const m=/^\s*(\d+)\s*$/.exec(raw)
  if(!m)return undefined
  const n=Number(m[1])
  return Number.isSafeInteger(n)&&n>0?n:undefined
}
export const issueBranch=(n:number)=>`issue-${n}-external-plan`
export function hashPlan(plan:unknown){return createHash('sha256').update(JSON.stringify(plan)).digest('hex')}

export function installIssueCommand(ctx:any,deps:{settings:(cwd?:string)=>any;orchestration:any}){
  if (!ctx.commands?.register) throw new Error('commands service unavailable')
  return ctx.commands.register({
    name:'plan-issue',
    description:'Execute a trusted external PlanArtifact from a GitHub Issue',
    input:{hint:'<issue-number>',attachments:false},
    recordInput:false,
    handler:async({agent,rawInput}:any)=>{
      try{
        const issueNumber=parseIssueInput(rawInput)
        if(!issueNumber)return{kind:'error',text:'Usage: /plan-issue <positive issue number>'}
        const cwd=agent.session.header?.cwd??process.cwd()
        const settings=deps.settings(cwd)
        if(!settings.externalIssue.enabled)return{kind:'error',text:'External Issue Mode is disabled in Settings → Plan Mode.'}
        const issue=await fetchIssue(cwd,issueNumber)
        const texts=[String(issue?.body??''),...(issue?.comments??[]).map((c:any)=>String(c?.body??''))]
        const contracts=texts.flatMap(extractExternalContracts)
        const selected=selectTrustedRevision(contracts)
        await ghPreflight(cwd,selected.externalPlan.repository)
        const evidence=texts.flatMap(extractCompletionEvidence)
        const current=await findCurrentCompletion(evidence,{
          revision:selected.externalPlan.revision,
          repository:selected.externalPlan.repository,
          issue:issueNumber,
          remoteHead:async pr=>{try{const remote=await remotePr(cwd,pr);return remote?.state==='OPEN'?remote.headRefOid:undefined}catch{return undefined}},
        })
        if(current)return{kind:'success',text:`Issue #${issueNumber} revision ${current.revision} is already complete at PR #${current.pr} (${current.head}).`}
        const branch=issueBranch(issueNumber)
        await prepareIssueBranch(cwd,branch,selected.externalPlan.baseCommit)
        const run=deps.orchestration.approve({
          sessionId:String(agent.session.id),agent,artifact:selected.plan,planHash:hashPlan(selected.plan),baselineHead:selected.externalPlan.baseCommit,
          externalIssue:{issueNumber,repository:selected.externalPlan.repository,revision:selected.externalPlan.revision,branch,publishAfterPass:Boolean(settings.externalIssue.publishAfterPass)},
        })
        if(!run)return{kind:'error',text:'Another Plan Orchestrator run is already active for this session.'}
        return{kind:'success',text:`Accepted Issue #${issueNumber} external plan revision ${selected.externalPlan.revision} on ${branch}. Execution run ${run} will start automatically.${settings.externalIssue.publishAfterPass?' PASS will publish/reuse a PR.':' Automatic PR publication is disabled.'}`}
      }catch(e){return{kind:'error',text:`External Issue Mode blocked: ${(e as Error).message}`}}
    },
  })
}
