import React from 'react'
export function Overview({ diagnostics, settings }: any) {
  const caps = [
    ['Native Plan Mode', diagnostics?.nativePlanMode], ['SDK parallel backend', diagnostics?.sdkAvailable],
    ['Git', diagnostics?.gitAvailable], ['LSP', diagnostics?.lspAvailable], ['gh', diagnostics?.ghAvailable],
    ['Settings writable', diagnostics?.settingsWritable],
  ]
  return <div className="planx-grid">
    <div className="planx-card"><h3>Compatibility</h3><div>DSH: {diagnostics?.dshVersion ?? 'detecting'}</div><div>Plugin: {diagnostics?.pluginVersion ?? '1.0.0'}</div><div>Supported: 0.1.5-rc.1</div><div>Preview: 0.1.5-rc.2</div></div>
    <div className="planx-card"><h3>Capabilities</h3><div className="planx-kv">{caps.flatMap(([name,value])=>[<span key={`${name}-n`}>{name}</span>,<span key={`${name}-v`}>{value===undefined?'—':value?'Available':'Unavailable'}</span>])}</div></div>
    <div className="planx-card"><h3>Safety</h3><div>Plan Orchestrator: {settings?.enabled?'enabled':'disabled'}</div><div>Strict Planner read-only: {settings?.planning?.strictReadOnly?'on':'off'}</div><div>Ownership / trusted validation: mandatory</div>{diagnostics?.readOnlyDegraded&&<div role="alert">Degraded: {diagnostics.readOnlyDegraded}</div>}</div>
  </div>
}
