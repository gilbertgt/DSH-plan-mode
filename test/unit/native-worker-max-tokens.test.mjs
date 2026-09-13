import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSpawnBackend } from '../../src/orchestration/native-backend.ts'
import { git } from '../../src/git/repository.ts'

const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-max-tokens-'))
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
    structured: {
      taskId,
      status: 'COMPLETE',
      changed: [],
      validation: [],
      remaining: [],
      contextExpansion: [],
    },
  }
}

function fakeCtx(sequence, { onStart } = {}) {
  const starts = []
  const queue = [...sequence]
  const ctx = {
    tools: {
      schemas: () => [
        { name: 'read' },
        { name: 'write' },
        { name: 'edit' },
      ],
      guard: () => () => {},
    },
    on: () => () => {},
    subagents: {
      start: async (_mode, options) => {
        const index = starts.length
        starts.push(options)
        await onStart?.(index, options)
        const result = queue.shift()
        if (!result) throw new Error('unexpected extra subagent start')
        return {
          result: Promise.resolve(result),
          localAgent: undefined,
          dispose: async () => {},
        }
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

test('native Worker gets exactly one fresh same-route continuation after max-tokens', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([
      { stopReason: 'max-tokens', diagnostic: 'output budget reached' },
      completed('t1'),
    ])
    const result = await new NativeSpawnBackend(ctx).run(request(root))

    assert.equal(result.status, 'COMPLETE')
    assert.equal(starts.length, 2)
    assert.equal(starts[0].label, 'worker:t1')
    assert.equal(starts[1].label, 'worker:t1:continue')
    assert.match(starts[1].prompt[0].text, /MAX-TOKENS CONTINUATION \(one retry only\)/)
    assert.match(starts[1].prompt[0].text, /current owned working tree is authoritative/i)
    assert.match(starts[1].prompt[0].text, /Do not repeat planning, repository-baseline discovery, \.git inspection, branch\/HEAD\/status checks/i)
  } finally {
    await cleanup(root)
  }
})

test('a second max-tokens stop fails closed and never loops indefinitely', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx([
      { stopReason: 'max-tokens', diagnostic: 'first cap' },
      { stopReason: 'max-tokens', diagnostic: 'second cap' },
    ])

    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      error => {
        assert.equal(error.code, 'max-tokens')
        assert.match(error.message, /second cap/)
        return true
      },
    )
    assert.equal(starts.length, 2, 'max-token recovery must be bounded to one continuation')
  } finally {
    await cleanup(root)
  }
})

test('max-token continuation is refused when the interrupted attempt mutated outside ownership', async () => {
  const root = await gitRepo()
  try {
    const { ctx, starts } = fakeCtx(
      [
        { stopReason: 'max-tokens', diagnostic: 'cap after unsafe mutation' },
        completed('t1'),
      ],
      {
        onStart: async index => {
          if (index === 0) await writeFile(join(root, 'outside.ts'), 'unsafe\n')
        },
      },
    )

    await assert.rejects(
      () => new NativeSpawnBackend(ctx).run(request(root)),
      /ownership/i,
    )
    assert.equal(starts.length, 1, 'ownership drift must fail before a continuation child is started')
  } finally {
    await cleanup(root)
  }
})
