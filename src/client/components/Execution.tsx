import React from 'react'
export function Execution({ settings, patch }: any) {
  const e = settings.execution
  return <div className="planx-card"><h3>Execution</h3>
    <label>Parallel mode <select value={e.parallelMode} onChange={x=>patch({parallelMode:x.target.value})}><option value="auto">Auto</option><option value="serial">Serial</option><option value="worktree">Worktree when safe</option></select></label>
    <label>Max parallel Workers <input type="number" min={1} max={8} value={e.maxParallelWorkers} onChange={x=>patch({maxParallelWorkers:Number(x.target.value)})}/></label>
    <label>SDK child profile <input value={e.sdkProfile} onChange={x=>patch({sdkProfile:x.target.value})}/></label>
    <label>Role timeout (ms) <input type="number" min={1000} max={3600000} value={e.roleTimeoutMs} onChange={x=>patch({roleTimeoutMs:Number(x.target.value)})}/></label>
    <label><span><input type="checkbox" checked={e.keepFailedWorktrees} onChange={x=>patch({keepFailedWorktrees:x.target.checked})}/> Retain failed worktrees for evidence</span></label>
    <p className="planx-muted">Explicit ownership is always enforced and cannot be disabled.</p>
  </div>
}
