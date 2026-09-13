import React, { useEffect, useState } from 'react'
import { phaseLabel } from '../role-route-ui.ts'

export function Recovery({ rpc, allowSafeResume, t }: any) {
  const [runs,setRuns]=useState<any[]>([]),[error,setError]=useState('')
  const load=()=>rpc('run-list',{}).then((r:any[])=>{setRuns(r);setError('')}).catch((e:any)=>setError(e.message))
  useEffect(()=>{void load()},[])
  return <div className="planx-card"><h3>{t('recovery.title')}</h3>{error&&<div role="alert">{error}</div>}<p className="planx-muted">{t('recovery.note')}</p>{runs.length===0?<p>{t('recovery.empty')}</p>:runs.slice(0,20).map(run=><div className="planx-row" key={run.runId}><code>{run.runId.slice(0,8)}</code><span>{phaseLabel(t,run.phase)}</span>{run.phase==='INTERRUPTED'&&<button disabled={!allowSafeResume} title={!allowSafeResume?t('recovery.resumeDisabled'):undefined} onClick={async()=>{const v=await rpc('run-resume',{runId:run.runId});if(!v.ok)setError(v.reason);await load()}}>{t('resume')}</button>}{['COMPLETE','FAILED','BLOCKED','CANCELLED'].includes(run.phase)&&<button onClick={async()=>{if(confirm(t('recovery.cleanupConfirm'))){await rpc('run-cleanup',{runId:run.runId});await load()}}}>{t('run.cleanup')}</button>}</div>)}</div>
}
