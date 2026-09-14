import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSpawnBackend } from '../../src/orchestration/native-backend.ts'
import { git } from '../../src/git/repository.ts'

const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-missing-contract-'))
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
    structured: { taskId, status: 'COMPLETE', changed: [], validation: [], remaining: [], contextExpansion: [] },
  }
}

/**
 * A turn that ends normally but never calls the structured completion tool.
 * DSH documents that requesting `outputSchema` does not guarantee a capture,
 * so this is a real, reachable child shape rather than a synthetic one.
 */
function completedWithoutContract({ output = [], diagnostic } = {}) {
  return {
    stopReason: 'completed',
    output,
    ...(diagnostic === undefined ? {} : { diagnostic }),
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

test('a completed turn without the contract gets one corrective retry that asks for the contract', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([completedWithoutContract(), completed('t1')])
    const result = await new NativeSpawnBackend(ctx).run(request(root))

    assert.equal(result.status, 'COMPLETE')
    assert.equal(starts.length, 2, 'exactly one corrective retry')
    assert.equal(starts[1].label, 'worker:t1:continue')
    // The retry must be told the contract is missing, not that it ran out of budget.
    assert.match(starts[1].prompt[0].text, /MISSING COMPLETION CONTRACT \(one retry only\)/)
    assert.doesNotMatch(starts[1].prompt[0].text, /MAX-TOKENS CONTINUATION/)
    // It must not invite redoing work that may already be correct.
    assert.match(starts[1].prompt[0].text, /Do not redo completed work/i)
    assert.match(starts[1].prompt[0].text, /current owned working tree is authoritative/i)
    assert.match(starts[1].prompt[0].text, /status BLOCKED/)
  } finally {
    await cleanup(root)
  }
})

test('the opaque "stopped: error" message is replaced by an actionable diagnosis', async () => {
  const root = await gitRepo()
  try {
    // Regression: this shape previously surfaced as the bare
    // `subagent X stopped: error`, naming neither cause nor fix.
    const { ctx, starts } = fakeCtx([
      completedWithoutContract(),
      completedWithoutContract({ output: [{ type: 'text', text: 'I inspected the files but stopped short.' }] }),
    ])

    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      error => {
        assert.equal(error.code, 'missing-contract')
        assert.match(error.message, /finished without returning the required structured completion contract/)
        assert.match(error.message, /I inspected the files but stopped short\./)
        assert.doesNotMatch(error.message, /^subagent t1 stopped: error$/)
        return true
      },
    )
    assert.equal(starts.length, 2, 'contract recovery must be bounded to one retry')
  } finally {
    await cleanup(root)
  }
})

test('a non-completed stop reason still reports its own reason and diagnostic', async () => {
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
    // Only max-tokens and a missing contract earn a retry; a refusal does not.
    assert.equal(starts.length, 1, 'a refusal must not be retried')
  } finally {
    await cleanup(root)
  }
})

test('contract retry is refused when the contractless attempt mutated outside ownership', async () => {
  const root = await gitRepo()
  try {
    const starts = []
    const queue = [completedWithoutContract(), completed('t1')]
    const ctx = {
      tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }], guard: () => () => {} },
      on: () => () => {},
      subagents: {
        start: async (_mode, options) => {
          const index = starts.length
          starts.push(options)
          // The child mutates a path outside its modify[] ownership, which the
          // continuation gate must detect before any corrective retry starts.
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
