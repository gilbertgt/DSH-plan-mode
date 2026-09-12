import React, { useEffect, useState } from 'react'
export function Recovery({ rpc, allowSafeResume }: any) {
  const [runs,setRuns]=useState<any[]>([]),[error,setError]=useState('')
  const load=()=>rpc('run-list',{}).then((r:any[])=>{setRuns(r);setError('')}).catch((e:any)=>setError(e.message))
  useEffect(()=>{void load()},[])
  return <div className="planx-card"><h3>Recovery</h3>{error&&<div role="alert">{error}</div>}<p className="planx-muted">Resume is available only when Safe Resume is enabled and an INTERRUPTED run's checkpoint still matches HEAD, ownership and working-tree fingerprint. No reset/clean/stash recovery exists.</p>{runs.length===0?<p>No loaded runs.</p>:runs.slice(0,20).map(run=><div className="planx-row" key={run.runId}><code>{run.runId.slice(0,8)}</code><span>{run.phase}</span>{run.phase==='INTERRUPTED'&&<button disabled={!allowSafeResume} title={!allowSafeResume?'Safe Resume is disabled in Plan Mode settings.':undefined} onClick={async()=>{const v=await rpc('run-resume',{runId:run.runId});if(!v.ok)setError(v.reason);await load()}}>Resume safely</button>}{['COMPLETE','FAILED','BLOCKED','CANCELLED'].includes(run.phase)&&<button onClick={async()=>{if(confirm('Cleanup this terminal run?')){await rpc('run-cleanup',{runId:run.runId});await load()}}}>Cleanup</button>}</div>)}</div>
}
