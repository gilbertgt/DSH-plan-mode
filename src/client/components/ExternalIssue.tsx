import React from 'react'

export function ExternalIssue({ settings, patch, t }: any) {
  const x = settings.externalIssue
  return <div className="planx-card"><h3>{t('external.title')}</h3>
    <label><span><input type="checkbox" checked={x.enabled} onChange={e=>patch({enabled:e.target.checked})}/> {t('external.enable')}</span></label>
    <label><span><input type="checkbox" checked={x.publishAfterPass} disabled={!x.enabled} onChange={e=>patch({publishAfterPass:e.target.checked})}/> {t('external.publishAfterPass')}</span></label>
    <p className="planx-muted">{t('external.note')}</p>
  </div>
}
