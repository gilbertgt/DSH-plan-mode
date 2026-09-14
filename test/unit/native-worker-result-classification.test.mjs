import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSpawnBackend } from '../../src/orchestration/native-backend.ts'
import { git } from '../../src/git/repository.ts'

const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-result-classification-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'test'])
  await writeFile(join(root, 'a.ts'), 'base\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

function completed(taskId) {
  return {
    stopReason: 'completed',
    structured: { taskId, status: 'COMPLETE', changed: ['a.ts'], validation: [], remaining: [], contextExpansion: [] },
  }
}

function fakeCtx(sequence) {
  const starts = []
  const queue = [...sequence]
  const ctx = {
    tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }], guard: () => () => {} },
    on: () => () => {},
    subagents: {
      start: async (_mode, options) => {
        starts.push(options)
        const result = queue.shift()
        if (!result) throw new Error('unexpected extra subagent start')
        return { result: Promise.resolve(result), localAgent: undefined, dispose: async () => {} }
      },
    },
  }
  return { ctx, starts }
}

function request(root, taskId = 't1') {
  return {
    parent: { session: { id: 'parent', header: { cwd: root } } },
    role: 'worker',
    taskId,
    prompt: 'implement the assigned task',
    route: { provider: 'test', model: 'test' },
    signal: new AbortController().signal,
    ownership: { root, paths: ['a.ts'] },
  }
}

/**
 * The exact shape run 4429470e produced: the child's own session log ends with
 * `turn/end reason.kind = "completed"` after a successful `write`, but the
 * requested structured completion contract is never captured and DSH reports
 * the run as `stopReason: "error"` with no diagnostic. The old classifier
 * treated that as a transport stop and surfaced the bare
 * `subagent t1-report-module stopped: error`, discarding both the cause and the
 * one corrective retry that exists for exactly this shape.
 */
function erroredWithoutContract({ output = [], diagnostic } = {}) {
  return {
    stopReason: 'error',
    output,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}

test('an errored turn without the contract earns the same one corrective retry as a completed one', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([erroredWithoutContract(), completed('t1')])
    const result = await new NativeSpawnBackend(ctx).run(request(root))

    assert.equal(result.status, 'COMPLETE')
    assert.equal(starts.length, 2, 'exactly one corrective retry for a contractless error stop')
    assert.equal(starts[1].label, 'worker:t1:continue')
    assert.match(starts[1].prompt[0].text, /MISSING COMPLETION CONTRACT \(one retry only\)/)
    assert.doesNotMatch(starts[1].prompt[0].text, /MAX-TOKENS CONTINUATION/)
  } finally {
    await cleanup(root)
  }
})

test('a contractless error stop that survives the retry names its reason and the child final message', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([
      erroredWithoutContract(),
      erroredWithoutContract({ output: [{ type: 'text', text: 'I refined the module but never called the contract tool.' }] }),
    ])

    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      error => {
        assert.match(error.message, /finished without returning the required structured completion contract/)
        assert.match(error.message, /I refined the module but never called the contract tool\./)
        assert.doesNotMatch(error.message, /^subagent t1 stopped: error$/)
        return true
      },
    )
    assert.equal(starts.length, 2, 'contract recovery stays bounded to one retry')
  } finally {
    await cleanup(root)
  }
})

test('a non-contract stop reason still reports its own reason first', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([{ stopReason: 'refusal', diagnostic: 'provider refused the request' }])
    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      error => {
        assert.equal(error.code, 'refusal')
        assert.match(error.message, /refusal/)
        assert.match(error.message, /provider refused the request/)
        return true
      },
    )
    assert.equal(starts.length, 1, 'a refusal must not be retried')
  } finally {
    await cleanup(root)
  }
})

test('a bare error stop with no diagnostic still carries the child final message', async () => {
  const root = await gitRepo()
  try {
    const { ctx } = fakeCtx([
      { stopReason: 'refusal', output: [{ type: 'text', text: 'the scope forbids this change' }] },
    ])
    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      error => {
        assert.equal(error.code, 'refusal')
        assert.match(error.message, /the scope forbids this change/)
        return true
      },
    )
  } finally {
    await cleanup(root)
  }
})

test('the corrective retry for a contractless error is refused when the tree escaped ownership', async () => {
  const root = await gitRepo()
  try {
    const starts = []
    const queue = [erroredWithoutContract(), completed('t1')]
    const ctx = {
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }], guard: () => () => {} },
      on: () => () => {},
      subagents: {
        start: async (_mode, options) => {
          const index = starts.length
          starts.push(options)
          if (index === 0) await writeFile(join(root, 'outside.ts'), 'unsafe\n')
          return { result: Promise.resolve(queue.shift()), localAgent: undefined, dispose: async () => {} }
        },
      },
    }

    await assert.rejects(() => new NativeSpawnBackend(ctx).run(request(root)), /ownership/i)
    assert.equal(starts.length, 1, 'ownership drift must fail before a corrective child starts')
  } finally {
    await cleanup(root)
  }
})
