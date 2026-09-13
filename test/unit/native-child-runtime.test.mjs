import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { NativeSpawnBackend } from '../../src/orchestration/native-backend.ts'
import { git } from '../../src/git/repository.ts'
import {
  installNativeChildRuntimeGuard,
  nativeChildRuntimeGuardReason,
} from '../../src/orchestration/native-child-runtime.ts'

function agent(cwd, parentSession = 'parent') {
  return { session: { header: { cwd, parentSession, origin: 'subagent' } } }
}

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-native-runtime-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'test'])
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'base\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

const cleanup = root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

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

test('NativeSpawnBackend installs the runtime fence before starting a mutating Worker', async () => {
  const root = await gitRepo()
  try {
    const guards = []
    let releases = 0
    let started = false
    const ctx = {
      on() { return () => {} },
      tools: {
        guard(fn) { guards.push(fn); return () => { releases++ } },
        schemas() { return [{ name: 'read' }, { name: 'write' }] },
      },
      subagents: {
        async start(provider, request) {
          assert.equal(provider, 'spawn')
          assert.equal(guards.length, 2)
          const child = agent(root)
          assert.ok(guards.some(guard => /leaf-role policy/.test(String(guard({ agent: child, name: 'subagent', arguments: {} }) ?? ''))))
          assert.ok(guards.some(guard => /worktree binding violation/.test(String(guard({ agent: agent(resolve(root, '..', 'wrong')), name: 'read', arguments: {} }) ?? ''))))
          started = true
          return {
            localAgent: undefined,
            result: Promise.resolve({
              stopReason: 'completed',
              structured: {
                taskId: 'task',
                status: 'COMPLETE',
                changed: [],
                validation: [],
                remaining: [],
                contextExpansion: [],
              },
            }),
            async dispose() {},
          }
        },
      },
    }
    const parent = { session: { id: 'parent', header: { cwd: root } } }
    const result = await new NativeSpawnBackend(ctx).run({
      parent,
      role: 'worker',
      taskId: 'task',
      prompt: 'do work',
      route: { provider: 'p', model: 'm' },
      signal: new AbortController().signal,
      ownership: { root, paths: ['src/a.ts'] },
    })

    assert.equal(started, true)
    assert.equal(result.status, 'COMPLETE')
    assert.equal(releases, 2)
  } finally {
    await cleanup(root)
  }
})
