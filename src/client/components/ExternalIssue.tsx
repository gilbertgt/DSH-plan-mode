import React from 'react'
export function ExternalIssue({ settings, patch }: any) {
  const x = settings.externalIssue
  return <div className="planx-card"><h3>External Issue</h3>
    <label><span><input type="checkbox" checked={x.enabled} onChange={e=>patch({enabled:e.target.checked})}/> Enable /plan-issue</span></label>
    <label><span><input type="checkbox" checked={x.publishAfterPass} disabled={!x.enabled} onChange={e=>patch({publishAfterPass:e.target.checked})}/> After Reviewer PASS, commit/push/create or reuse PR</span></label>
    <p className="planx-muted">Publication remains fail-closed: trusted revision, repo match, current validation receipts and Reviewer PASS are required. Force push and auto-merge are never used.</p>
  </div>
}
