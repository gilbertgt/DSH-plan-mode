import test from 'node:test'
import assert from 'node:assert/strict'
import { installNativeMutatingChildSandbox } from '../../src/orchestration/native-child-policy.ts'
import { ownershipGuardReason } from '../../src/orchestration/ownership-guard.ts'

function fakeContext() {
  const listeners = new Set()
  return {
    ctx: {
      on(event, listener) {
        assert.equal(event, 'agent/created')
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit(agent) {
      for (const listener of [...listeners]) listener({ agent })
    },
    listenerCount() { return listeners.size },
  }
}

function sessionWithDelegatedReadOnly() {
  const events = [
    { type: 'sandbox/mode', data: { mode: 'read-only', source: 'delegation' } },
    { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
  ]
  return {
    events,
    append(type, data) { events.push({ type, data }) },
  }
}

function lastEvent(session, type) {
  return [...session.events].reverse().find(event => event.type === type)
}

test('marked native mutating child overrides delegated read-only sandbox without touching parent or approval', () => {
  const harness = fakeContext()
  const parentSession = sessionWithDelegatedReadOnly()
  const childSession = sessionWithDelegatedReadOnly()
  const scope = installNativeMutatingChildSandbox(harness.ctx)
  const options = scope.mark({ provider: 'p', model: 'm' })

  harness.emit({ options, session: childSession })

  assert.equal(lastEvent(childSession, 'sandbox/mode').data.mode, 'workspace-write')
  assert.equal(lastEvent(childSession, 'approval/policy').data.policy, 'never')
  assert.equal(lastEvent(parentSession, 'sandbox/mode').data.mode, 'read-only')
  assert.equal(lastEvent(parentSession, 'approval/policy').data.policy, 'never')

  scope.dispose()
  assert.equal(harness.listenerCount(), 0)
})

test('unmarked Reviewer child remains read-only', () => {
  const harness = fakeContext()
  const childSession = sessionWithDelegatedReadOnly()
  const scope = installNativeMutatingChildSandbox(harness.ctx)

  harness.emit({ options: { provider: 'p', model: 'm' }, session: childSession })

  assert.equal(lastEvent(childSession, 'sandbox/mode').data.mode, 'read-only')
  assert.equal(lastEvent(childSession, 'approval/policy').data.policy, 'never')
  scope.dispose()
})

test('concurrent native mutation scopes match only their exact child marker', () => {
  const harness = fakeContext()
  const first = installNativeMutatingChildSandbox(harness.ctx)
  const second = installNativeMutatingChildSandbox(harness.ctx)
  const firstSession = sessionWithDelegatedReadOnly()

  harness.emit({ options: first.mark({ provider: 'p', model: 'm' }), session: firstSession })

  const workspaceEvents = firstSession.events.filter(event => event.type === 'sandbox/mode' && event.data.mode === 'workspace-write')
  assert.equal(workspaceEvents.length, 1)
  first.dispose()
  second.dispose()
  assert.equal(harness.listenerCount(), 0)
})

test('workspace-write does not broaden exact-path ownership enforcement', () => {
  const root = process.cwd()
  assert.equal(ownershipGuardReason(root, ['test/unit/locales.test.mjs'], 'write', { path: 'test/unit/locales.test.mjs' }), undefined)
  assert.match(
    ownershipGuardReason(root, ['test/unit/locales.test.mjs'], 'write', { path: 'src/client/locales.ts' }),
    /Plan Orchestrator ownership violation: src\/client\/locales\.ts/,
  )
})
