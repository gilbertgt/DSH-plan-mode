import React, { useEffect, useRef, useState } from 'react'
import { Overview } from './components/Overview.tsx'
import { Roles } from './components/Roles.tsx'
import { Planning } from './components/Planning.tsx'
import { Execution } from './components/Execution.tsx'
import { Review } from './components/Review.tsx'
import { Recovery } from './components/Recovery.tsx'
import { ExternalIssue } from './components/ExternalIssue.tsx'
import { Diagnostics } from './components/Diagnostics.tsx'
import { validateSettings } from '../contract/settings.ts'

// Tab labels come from the `tabs.*` dictionary keys; the ids stay internal.
const tabs = ['overview', 'roles', 'planning', 'execution', 'review', 'recovery', 'external', 'diagnostics'] as const
const settingFields = ['enabled', 'roles', 'planning', 'execution', 'review', 'recovery', 'externalIssue', 'workspaceOverrides'] as const

export function PlanModeSection({ rpc, t, settingsScope }: any) {
  const [tab,setTab]=useState('overview'),[diag,setDiag]=useState<any>(),[settings,setSettings]=useState<any>(),[catalog,setCatalog]=useState<any[]>([]),[dirty,setDirty]=useState(false),[error,setError]=useState('')
  const draftRevision=useRef<number|undefined>()
  useEffect(()=>settingsScope.subscribe(()=>{const snap=settingsScope.getSnapshot();if(!dirty&&snap.status==='ready'&&snap.value){setSettings(snap.value);draftRevision.current=snap.revision}}),[settingsScope,dirty])
  useEffect(()=>{const snap=settingsScope.getSnapshot();if(snap.status==='ready'&&snap.value){setSettings(snap.value);draftRevision.current=snap.revision}void Promise.all([rpc('diagnostics'),rpc('model-catalog')]).then(([d,c])=>{setDiag(d);setCatalog(c)}).catch((e:any)=>setError(e.message))},[rpc,settingsScope])
  const mutate=(path:string,patch:any)=>{setSettings((s:any)=>({...s,[path]:{...s[path],...patch}}));setDirty(true)}
  const onRole=(role:string,value:any)=>{setSettings((s:any)=>({...s,roles:{...s.roles,[role]:value}}));setDirty(true)}
  const save=async()=>{try{const checked=validateSettings(settings);const ops=settingFields.map(field=>({op:'set',path:[field],value:checked[field]}));const expected=draftRevision.current;await settingsScope.mutate(ops,expected);const snap=settingsScope.getSnapshot();if(snap.status!=='ready'||JSON.stringify(snap.value)!==JSON.stringify(checked))throw new Error(t('errors.settingsConcurrent'));setSettings(snap.value);draftRevision.current=snap.revision;setDirty(false);setError('')}catch(e:any){setError(e.message)}}
  const tabRefs=useRef<Array<HTMLButtonElement|null>>([]);const key=(event:React.KeyboardEvent,index:number)=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;if(event.key==='ArrowRight')next=(index+1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;setTab(tabs[next]!);tabRefs.current[next]?.focus()}
  if(!settings)return <section className="planx"><p>{t('loading')}</p>{error&&<div role="alert">{error}</div>}</section>
  let content:React.ReactNode
  if(tab==='overview')content=<Overview diagnostics={diag} settings={settings} t={t}/>
  else if(tab==='roles')content=<Roles settings={settings} catalog={catalog} onRole={onRole} rpc={rpc} t={t}/>
  else if(tab==='planning')content=<Planning settings={settings} patch={(p:any)=>mutate('planning',p)} t={t}/>
  else if(tab==='execution')content=<Execution settings={settings} patch={(p:any)=>mutate('execution',p)} t={t}/>
  else if(tab==='review')content=<Review settings={settings} patch={(p:any)=>mutate('review',p)} t={t}/>
  else if(tab==='recovery')content=<Recovery rpc={rpc} allowSafeResume={settings.recovery.allowSafeResume} t={t}/>
  else if(tab==='external')content=<ExternalIssue settings={settings} patch={(p:any)=>mutate('externalIssue',p)} t={t}/>
  else content=<Diagnostics diagnostics={diag} t={t}/>
  return <section className="planx"><div className="planx-row planx-between"><h2>{t('nav')}</h2><div className="planx-row"><label><span><input type="checkbox" checked={settings.enabled} onChange={e=>{setSettings((s:any)=>({...s,enabled:e.target.checked}));setDirty(true)}}/> {t('enabled')}</span></label>{dirty&&<button onClick={save}>{t('save')}</button>}</div></div>{error&&<div role="alert" className="planx-error">{error}</div>}<div className="planx-tabs" role="tablist" aria-label={t('tabs.aria')}>{tabs.map((id,index)=><button ref={el=>{tabRefs.current[index]=el}} role="tab" aria-selected={tab===id} tabIndex={tab===id?0:-1} key={id} onKeyDown={e=>key(e,index)} onClick={()=>setTab(id)}>{t('tabs.'+id)}</button>)}</div>{content}</section>
}
