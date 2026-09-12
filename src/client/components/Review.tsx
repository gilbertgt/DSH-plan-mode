import React from 'react'
export function Review({ settings, patch }: any) {
  const r = settings.review
  return <div className="planx-card"><h3>Review</h3>
    <label>Maximum targeted-fix rounds <input type="number" min={0} max={5} value={r.maxReviewRounds} onChange={e=>patch({maxReviewRounds:Number(e.target.value)})}/></label>
    <label>Reviewer protocol retry <select value={r.protocolRetry} onChange={e=>patch({protocolRetry:Number(e.target.value)})}><option value={0}>0</option><option value={1}>1</option></select></label>
    <label>Per-stream output cap (bytes) <input type="number" min={1024} max={16777216} value={r.outputCapBytes} onChange={e=>patch({outputCapBytes:Number(e.target.value)})}/></label>
    <p className="planx-muted">Trusted host validation is mandatory. Worker self-reports are never accepted as proof.</p>
  </div>
}
