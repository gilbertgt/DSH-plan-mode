import React from 'react'

export function Diagnostics({ diagnostics, t }: any) { return <div className="planx-card"><h3>{t('diagnostics.title')}</h3><pre>{JSON.stringify(diagnostics ?? {}, null, 2)}</pre><p className="planx-muted">{t('diagnostics.note')}</p></div> }
