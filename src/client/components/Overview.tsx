import React from 'react'

export function Overview({ diagnostics, settings, t }: any) {
  const capabilities = [
    ['overview.capability.nativePlanMode', diagnostics?.nativePlanMode],
    ['overview.capability.sdkParallel', diagnostics?.sdkAvailable],
    ['overview.capability.git', diagnostics?.gitAvailable],
    ['overview.capability.lsp', diagnostics?.lspAvailable],
    ['overview.capability.gh', diagnostics?.ghAvailable],
    ['overview.capability.settingsWritable', diagnostics?.settingsWritable],
  ] as const
  const available = (value: unknown) => value === undefined ? '—' : value ? t('common.available') : t('common.unavailable')
  // Versions and capability state are host data; only the labels are localized.
  const supported = (diagnostics?.compatibility?.supported ?? []).join(', ')
  const preview = (diagnostics?.compatibility?.preview ?? []).join(', ')

  return <div className="planx-grid">
    <div className="planx-card">
      <h3>{t('overview.compatibility')}</h3>
      <div>{t('overview.dshVersion')}: {diagnostics?.dshVersion ?? t('common.detecting')}</div>
      <div>{t('overview.pluginVersion')}: {diagnostics?.pluginVersion ?? t('common.detecting')}</div>
      {supported && <div>{t('overview.supported')}: {supported}</div>}
      {preview && <div>{t('overview.preview')}: {preview}</div>}
    </div>
    <div className="planx-card">
      <h3>{t('overview.capabilities')}</h3>
      <div className="planx-kv">{capabilities.flatMap(([name, value]) => [
        <span key={`${name}-n`}>{t(name)}</span>,
        <span key={`${name}-v`}>{available(value)}</span>,
      ])}</div>
    </div>
    <div className="planx-card">
      <h3>{t('overview.safety')}</h3>
      <div>{t('overview.orchestrator')}: {settings?.enabled ? t('common.enabled') : t('common.disabled')}</div>
      <div>{t('overview.strictReadOnly')}: {settings?.planning?.strictReadOnly ? t('common.on') : t('common.off')}</div>
      <div>{t('overview.ownership')}: {t('common.mandatory')}</div>
      {diagnostics?.readOnlyDegraded && <div role="alert">{t('overview.degraded', { reason: diagnostics.readOnlyDegraded })}</div>}
    </div>
  </div>
}
