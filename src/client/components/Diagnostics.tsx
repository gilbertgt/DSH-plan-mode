import React from 'react'
export function Diagnostics({ diagnostics }: any) { return <div className="planx-card"><h3>Diagnostics</h3><pre>{JSON.stringify(diagnostics ?? {}, null, 2)}</pre><p className="planx-muted">Diagnostics intentionally expose capability state and plugin storage location, never credentials or raw validation logs.</p></div> }
