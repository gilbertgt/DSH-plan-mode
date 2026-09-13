import React from 'react'

export function Planning({ settings, patch, t }: any) {
  const p = settings.planning
  return <div className="planx-card"><h3>{t('planning.title')}</h3>
    <label><span><input type="checkbox" checked={p.adaptiveResearch} onChange={e=>patch({adaptiveResearch:e.target.checked})}/> {t('planning.adaptiveResearch')}</span></label>
    <label><span><input type="checkbox" checked={p.strictReadOnly} onChange={e=>patch({strictReadOnly:e.target.checked})}/> {t('planning.strictReadOnly')}</span></label>
    <label>{t('planning.maxInitialReadFiles')} <input type="number" min={1} max={32} value={p.maxInitialReadFiles} onChange={e=>patch({maxInitialReadFiles:Number(e.target.value)})}/></label>
    <label>{t('planning.softInputTokens')} <input type="number" min={1000} value={p.softInputTokens} onChange={e=>patch({softInputTokens:Number(e.target.value)})}/></label>
    <label><span><input type="checkbox" checked={p.progressiveDiscovery} onChange={e=>patch({progressiveDiscovery:e.target.checked})}/> {t('planning.progressiveDiscovery')}</span></label>
    <label><span><input type="checkbox" checked={p.requireExpansionReason} onChange={e=>patch({requireExpansionReason:e.target.checked})}/> {t('planning.requireExpansionReason')}</span></label>
  </div>
}
