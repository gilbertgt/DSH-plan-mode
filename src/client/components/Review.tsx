import React from 'react'

export function Review({ settings, patch, t }: any) {
  const r = settings.review
  return <div className="planx-card"><h3>{t('review.title')}</h3>
    <label>{t('review.maxRounds')} <input type="number" min={0} max={5} value={r.maxReviewRounds} onChange={e=>patch({maxReviewRounds:Number(e.target.value)})}/></label>
    <label>{t('review.protocolRetry')} <select value={r.protocolRetry} onChange={e=>patch({protocolRetry:Number(e.target.value)})}><option value={0}>0</option><option value={1}>1</option></select></label>
    <label>{t('review.outputCap')} <input type="number" min={1024} max={16777216} value={r.outputCapBytes} onChange={e=>patch({outputCapBytes:Number(e.target.value)})}/></label>
    <p className="planx-muted">{t('review.note')}</p>
  </div>
}
