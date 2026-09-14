import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationService } from '../../src/orchestration/service.ts'
import { RunStore } from '../../src/recovery/store.ts'

const artifact = {
  planModeVersion: 1,
  summary: 'x',
  complexity: 'small',
  decisionLocks: [],
  tasks: [
    { id: 't1', title: 't1', objective: 'o', read: ['a.ts'], modify: ['a.ts'], decisionLocks: [], requiredChanges: ['x'], acceptanceCriteria: ['ok'], validation: [], dependsOn: [], parallelSafe: true },
    { id: 't2', title: 't2', objective: 'o', read: ['b.ts'], modify: ['b.ts'], decisionLocks: [], requiredChanges: ['x'], acceptanceCriteria: ['ok'], validation: [], dependsOn: [], parallelSafe: true },
  ],
  validationStrategy: [],
  validationCommands: [],
  risks: [],
  outOfScope: [],
}

/** A recording agent whose delivery surfaces can be made to throw. */
function agent(sessionId, { failDelivery = false } = {}) {
  const calls = { followup: [], inject: [] }
  const events = []
  const session = {
    id: sessionId,
    header: { cwd: process.cwd() },
    append(type, data) { events.push({ type, data }) },
    snapshotEvents() { return events },
  }
  return {
    calls,
    status: 'busy',
    session,
    followup(message) {
      if (failDelivery) throw new Error('followup unavailable')
      calls.followup.push(message)
    },
    inject(message) {
      if (failDelivery) throw new Error('inject unavailable')
      calls.inject.push(message)
    },
    runMaintenance(fn) { return Promise.resolve().then(() => fn(new AbortController().signal)) },
  }
}

const cleanup = root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function waitForTerminal(store, sessionId, runId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const manifest = await store.readManifest(sessionId, runId).catch(() => undefined)
    if (manifest?.terminal) return manifest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('run never reached a terminal manifest')
}

/**
 * Wait for the terminal manifest AND for `finalize` to stop writing.
 *
 * The manifest becomes terminal before the failure record is indexed and before
 * the report is delivered, so a test that removes the run directory as soon as
 * the manifest is terminal races the remaining writes and fails with ENOTEMPTY
 * instead of on anything the run actually did.
 */
async function settle(store, sessionId, runId) {
  const manifest = await waitForTerminal(store, sessionId, runId)
  const dir = store.runDir(sessionId, runId)
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    const names = await readdir(dir).catch(() => [])
    if (!names.some(name => name.endsWith('.tmp'))) break
  }
  return manifest
}

/**
 * The failure shape of run 4429470e: a parallel wave announces both tasks, the
 * wave fails, and the run converges on FAILED without either task ever emitting
 * a `task-end`. Before this change the in-memory and projected views still
 * listed the tasks as active, so a finished run rendered as still working.
 */
test('a FAILED run clears active tasks in the view and the projection, and records a durable failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-terminal-failure-'))
  try {
    const store = new RunStore(root)
    let service
    const runner = async (_launch, runId) => {
      service.recordEvent('task-start', { runId, taskId: 't1' })
      service.recordEvent('task-start', { runId, taskId: 't2' })
      const error = new Error('subagent t1 finished without returning the required structured completion contract')
      error.code = 'missing-contract'
      throw error
    }
    service = new OrchestrationService(store, runner)
    const a = agent('s-failed')
    const runId = service.approve({ sessionId: a.session.id, agent: a, artifact, planHash: 'h' })
    assert.equal(await service.onParentIdle(a.session.id), true)
    const manifest = await settle(store, a.session.id, runId)

    assert.equal(manifest.phase, 'FAILED')
    assert.equal(manifest.terminal, true)

    const view = service.list(a.session.id).find(row => row.runId === runId)
    assert.equal(view.phase, 'FAILED')
    assert.deepEqual(view.activeTaskIds, [], 'a terminal run must not still list an active task')
    assert.match(String(view.message), /structured completion contract/)

    // The projection is the surface the sidebar reads; it must agree.
    const terminal = a.session.snapshotEvents().filter(event => event.type === 'planx/run-terminal')
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0].data.phase, 'FAILED')
    const starts = a.session.snapshotEvents().filter(event => event.type === 'planx/task-start').length
    const ends = a.session.snapshotEvents().filter(event => event.type === 'planx/task-end').length
    assert.equal(starts, 2)
    assert.equal(ends, 0, 'the wave never emitted task-end')

    // A finished run has to stay diagnosable after the process is gone.
    const failure = JSON.parse(await readFile(join(store.runDir(a.session.id, runId), 'failure.json'), 'utf8'))
    assert.equal(failure.phase, 'FAILED')
    assert.equal(failure.cause.code, 'missing-contract')
    assert.deepEqual(failure.cause.chain, [failure.cause.message])
    assert.ok(manifest.failureArtifact?.sha256, 'the manifest must index the failure artifact')

    // Exactly one waking report reached the conversation.
    assert.equal(a.calls.followup.length, 1, 'exactly one terminal report')
    assert.equal(a.calls.inject.length, 0)
  } finally {
    await cleanup(root)
  }
})

test('each terminal phase delivers exactly one report, and CANCELLED does not wake the parent', async () => {
  for (const phase of ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED']) {
    const root = await mkdtemp(join(tmpdir(), `planx-terminal-${phase}-`))
    try {
      const store = new RunStore(root)
      let service
      const runner = async (_launch, runId) => {
        service.recordEvent('task-start', { runId, taskId: 't1' })
        if (phase === 'COMPLETE') return
        const error = new Error(`runner converged on ${phase}`)
        if (phase === 'BLOCKED') error.code = 'BLOCKED_BOUNDARY'
        throw error
      }
      service = new OrchestrationService(store, runner)
      const a = agent(`s-${phase}`)
      const runId = service.approve({ sessionId: a.session.id, agent: a, artifact, planHash: 'h' })
      if (phase === 'CANCELLED') {
        // The pending path owns cancellation: no controller is registered yet.
        assert.equal(await service.cancel(runId, 'user requested stop'), true)
      } else {
        assert.equal(await service.onParentIdle(a.session.id), true)
        await settle(store, a.session.id, runId)
      }
      await new Promise(resolve => setTimeout(resolve, 20))

      const view = service.list(a.session.id).find(row => row.runId === runId)
      assert.deepEqual(view.activeTaskIds, [], `${phase} must clear active tasks`)
      if (phase === 'CANCELLED') {
        assert.equal(a.calls.followup.length, 0, 'CANCELLED must not wake the parent')
        assert.equal(a.calls.inject.length, 1, 'CANCELLED queues context only')
      } else {
        assert.equal(a.calls.followup.length, 1, `${phase} delivers exactly one waking report`)
        assert.equal(a.calls.inject.length, 0)
      }
    } finally {
      await cleanup(root)
    }
  }
})

test('a typed blocking boundary is reported as BLOCKED, a plain fault as FAILED', async () => {
  const cases = [
    { label: 'typed boundary', code: 'BLOCKED_BOUNDARY', message: 'runner stopped', expected: 'BLOCKED' },
    // The message contains no boundary word and the error is untyped: this must
    // not be promoted to BLOCKED merely because it sounds like a safety stop.
    { label: 'plain fault', code: undefined, message: 'provider returned 503 after 3 attempts', expected: 'FAILED' },
  ]
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `planx-terminal-${item.expected}-`))
    try {
      const store = new RunStore(root)
      const service = new OrchestrationService(store, async () => {
        const error = new Error(item.message)
        if (item.code) error.code = item.code
        throw error
      })
      const a = agent(`s-${item.expected}`)
      const runId = service.approve({ sessionId: a.session.id, agent: a, artifact, planHash: 'h' })
      assert.equal(await service.onParentIdle(a.session.id), true)
      const manifest = await settle(store, a.session.id, runId)
      assert.equal(manifest.phase, item.expected, `${item.label} must converge on ${item.expected}`)
    } finally {
      await cleanup(root)
    }
  }
})

test('a throwing delivery surface never changes the terminal phase and finalize still converges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-terminal-delivery-fault-'))
  try {
    const store = new RunStore(root)
    const runner = async () => { throw new Error('runner failed for an unrelated reason') }
    const service = new OrchestrationService(store, runner)
    const a = agent('s-delivery-fault', { failDelivery: true })
    const runId = service.approve({ sessionId: a.session.id, agent: a, artifact, planHash: 'h' })
    assert.equal(await service.onParentIdle(a.session.id), true)
    const manifest = await settle(store, a.session.id, runId)

    assert.equal(manifest.phase, 'FAILED')
    assert.equal(manifest.terminal, true)
    const view = service.list(a.session.id).find(row => row.runId === runId)
    assert.equal(view.phase, 'FAILED')
    assert.equal(
      a.session.snapshotEvents().some(event => event.type === 'planx/run-terminal' && event.data.phase === 'FAILED'),
      true,
      'the terminal session event must survive a delivery fault',
    )
  } finally {
    await cleanup(root)
  }
})

test('a pending cancellation releases the parent fence even when the terminal append is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-terminal-pending-cancel-'))
  try {
    const store = new RunStore(root)
    const service = new OrchestrationService(store, async () => {})
    const events = []
    const session = {
      id: 's-pending-fence',
      header: { cwd: process.cwd() },
      append(type, data) {
        if (type === 'planx/run-terminal') throw new Error('session append unavailable')
        events.push({ type, data })
      },
      snapshotEvents() { return events },
    }
    const a = { status: 'busy', session, runMaintenance(fn) { return Promise.resolve().then(() => fn(new AbortController().signal)) } }
    const runId = service.approve({ sessionId: session.id, agent: a, artifact, planHash: 'h' })

    assert.equal(await service.cancel(runId, 'disabled'), true)
    assert.equal(service.shouldFence(session.id), false, 'the pending fence must be released on every path')
    assert.equal(service.activeRun(session.id), undefined)
    const manifest = await store.readManifest(session.id, runId)
    assert.equal(manifest.phase, 'CANCELLED')
    assert.equal(manifest.terminal, true)
  } finally {
    await cleanup(root)
  }
})
