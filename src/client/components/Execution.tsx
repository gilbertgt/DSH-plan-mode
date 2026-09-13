import React from 'react'

// `parallelMode` is an internal settings value; only its display label is localized.
const PARALLEL_LABELS: Record<string, string> = {
  auto: 'execution.parallelAuto',
  serial: 'execution.parallelSerial',
  worktree: 'execution.parallelWorktree',
}

export function Execution({ settings, patch, t }: any) {
  const e = settings.execution
  return <div className="planx-card"><h3>{t('execution.title')}</h3>
    <label>{t('execution.parallelMode')} <select value={e.parallelMode} onChange={x=>patch({parallelMode:x.target.value})}>{Object.entries(PARALLEL_LABELS).map(([value,key])=><option key={value} value={value}>{t(key)}</option>)}</select></label>
    <label>{t('execution.maxParallelWorkers')} <input type="number" min={1} max={8} value={e.maxParallelWorkers} onChange={x=>patch({maxParallelWorkers:Number(x.target.value)})}/></label>
    <label>{t('execution.sdkProfile')} <input value={e.sdkProfile} onChange={x=>patch({sdkProfile:x.target.value})}/></label>
    <label>{t('execution.roleTimeout')} <input type="number" min={1000} max={3600000} value={e.roleTimeoutMs} onChange={x=>patch({roleTimeoutMs:Number(x.target.value)})}/></label>
    <label><span><input type="checkbox" checked={e.keepFailedWorktrees} onChange={x=>patch({keepFailedWorktrees:x.target.checked})}/> {t('execution.keepFailedWorktrees')}</span></label>
    <p className="planx-muted">{t('execution.timeoutNote')}</p>
  </div>
}
