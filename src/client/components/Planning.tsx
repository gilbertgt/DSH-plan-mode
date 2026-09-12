import React from 'react'
export function Planning({ settings, patch }: any) {
  const p = settings.planning
  return <div className="planx-card"><h3>Planning</h3>
    <label><span><input type="checkbox" checked={p.adaptiveResearch} onChange={e=>patch({adaptiveResearch:e.target.checked})}/> Adaptive Research</span></label>
    <label><span><input type="checkbox" checked={p.strictReadOnly} onChange={e=>patch({strictReadOnly:e.target.checked})}/> Strict Planner read-only</span></label>
    <label>Initial read-file budget <input type="number" min={1} max={32} value={p.maxInitialReadFiles} onChange={e=>patch({maxInitialReadFiles:Number(e.target.value)})}/></label>
    <label>Soft input-token budget <input type="number" min={1000} value={p.softInputTokens} onChange={e=>patch({softInputTokens:Number(e.target.value)})}/></label>
    <label><span><input type="checkbox" checked={p.progressiveDiscovery} onChange={e=>patch({progressiveDiscovery:e.target.checked})}/> Progressive discovery</span></label>
    <label><span><input type="checkbox" checked={p.requireExpansionReason} onChange={e=>patch({requireExpansionReason:e.target.checked})}/> Require reason before context expansion</span></label>
  </div>
}
