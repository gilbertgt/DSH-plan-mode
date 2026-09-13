import React from 'react'
import { zh, en } from './locales.ts'
import { STYLE } from './styles.ts'
import { createRpc } from './rpc-client.ts'
import { PlanModeSection } from './section.tsx'
import { RunChip } from './run-chip.tsx'
import { RunOverlay, RunOverlayService } from './run-overlay.tsx'
import { SETTINGS_NAMESPACE } from '../contract/settings.ts'
import { validateSettings } from '../contract/settings.ts'

export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'sessions']

export function apply(ctx: any) {
  const NS = 'plan-orchestrator'
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plan-orchestrator: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plan-orchestrator'
    style.textContent = STYLE
    document.head.append(style)
    return () => style.remove()
  }, 'plan-orchestrator: style')

  const t = ctx.locale.bind(NS)
  const rpc = createRpc()
  const settingsScope = ctx.settingsScope.bind({
    namespace: SETTINGS_NAMESPACE,
    decode(value: unknown) {
      try { return validateSettings(value) } catch { return undefined }
    },
  })
  const overlay = new RunOverlayService()
  ctx.effect(() => () => overlay.close(), 'plan-orchestrator: overlay service')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'plan-orchestrator', order: 20,
    label: () => t('nav'), locale: NS,
    inject: () => ({ rpc, t, settingsScope }),
  }, PlanModeSection))

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'plan-orchestrator-run', order: 20, locale: NS,
    inject: (sessionId: string) => ({ rpc, sessionId, overlay, t }),
  }, RunChip))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'plan-orchestrator-run-overlay', order: 21, locale: NS,
    inject: () => ({ service: overlay, rpc, t }),
  }, RunOverlay))
}
