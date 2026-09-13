import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  installNativeChildRuntimeGuard,
  nativeChildRuntimeGuardReason,
} from '../../src/orchestration/native-child-runtime.ts'

function agent(cwd, parentSession = 'parent') {
  return { session: { header: { cwd, parentSession, origin: 'subagent' } } }
}

test('native child runtime guard allows ordinary tools only in the exact Plan worktree', () => {
  const root = resolve(process.cwd(), 'plan-root')
  assert.equal(nativeChildRuntimeGuardReason(root, agent(root), 'read'), undefined)
  assert.equal(nativeChildRuntimeGuardReason(root, agent(root), 'write'), undefined)
  assert.match(
    nativeChildRuntimeGuardReason(root, agent(resolve(root, '..', 'stale-root')), 'read'),
    /worktree binding violation/,
  )
  assert.match(
    nativeChildRuntimeGuardReason(root, { session: { header: {} } }, 'read'),
    /child cwd is unavailable/,
  )
})

test('native child runtime guard makes Plan workers leaf executors', () => {
  const root = resolve(process.cwd(), 'plan-root')
  for (const tool of ['subagent', 'subagent_fork', 'subagent_codex', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph']) {
    assert.match(nativeChildRuntimeGuardReason(root, agent(root), tool), /leaf-role policy/)
  }
})

test('installed runtime guard applies only to the exact direct Plan child and releases cleanly', () => {
  const root = resolve(process.cwd(), 'plan-root')
  let guard
  let releases = 0
  const ctx = { tools: { guard(fn) { guard = fn; return () => { releases++ } } } }
  const parent = { session: { id: 'parent' } }
  const release = installNativeChildRuntimeGuard(ctx, parent, root)

  assert.equal(guard({ agent: agent(root, 'other'), name: 'subagent', arguments: {} }), undefined)
  assert.equal(guard({ agent: { session: { header: { cwd: root, parentSession: 'parent', origin: 'user' } } }, name: 'subagent', arguments: {} }), undefined)
  assert.match(guard({ agent: agent(root), name: 'subagent', arguments: {} }), /leaf-role policy/)
  assert.match(guard({ agent: agent(resolve(root, '..', 'wrong')), name: 'read', arguments: {} }), /worktree binding violation/)

  release()
  assert.equal(releases, 1)
})

test('runtime guard fails closed when guard or parent session APIs are unavailable', () => {
  assert.throws(() => installNativeChildRuntimeGuard({ tools: {} }, { session: { id: 'parent' } }, process.cwd()), /tools\.guard unavailable/)
  assert.throws(() => installNativeChildRuntimeGuard({ tools: { guard() {} } }, {}, process.cwd()), /parent session unavailable/)
})
