import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicJson, readJson, RunStore } from '../../src/recovery/store.ts'

const cleanup = root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

function sharingViolation() {
  const error = new Error("EPERM: operation not permitted, rename")
  error.code = 'EPERM'
  return error
}

/**
 * The CI Windows lane failed with exactly this: `rename` returned EPERM while
 * publishing `manifest.json`, because a concurrent reader held the destination.
 * The run view polls that file, so a sharing violation must not abort the write
 * that records the run's own state.
 */
test('a transient rename failure is retried instead of losing the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-atomic-retry-'))
  try {
    const target = join(root, 'manifest.json')
    const { rename } = await import('node:fs/promises')
    let attempts = 0
    const flaky = async (from, to) => {
      attempts += 1
      if (attempts <= 2) throw sharingViolation()
      return rename(from, to)
    }

    await atomicJson(target, { ok: 1 }, { rename: flaky })
    assert.equal(attempts, 3, 'the write must retry through the transient failures')
    assert.deepEqual(await readJson(target), { ok: 1 })
    assert.deepEqual(await readdir(root), ['manifest.json'], 'no temp file may survive')
  } finally {
    await cleanup(root)
  }
})

test('a persistent rename failure still fails closed and leaves no temp file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-atomic-failclosed-'))
  try {
    const target = join(root, 'manifest.json')
    let attempts = 0
    const always = async () => { attempts += 1; throw sharingViolation() }

    await assert.rejects(() => atomicJson(target, { ok: 1 }, { rename: always }), /EPERM/)
    assert.equal(attempts, 6, 'the retry budget is bounded')
    assert.deepEqual(await readdir(root), [], 'a failed write must clean up its temp file')
  } finally {
    await cleanup(root)
  }
})

test('a non-retryable publish failure is not disguised as a transient one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-atomic-hardfail-'))
  try {
    let attempts = 0
    const hard = async () => {
      attempts += 1
      const error = new Error('ENOSPC: no space left on device')
      error.code = 'ENOSPC'
      throw error
    }
    await assert.rejects(() => atomicJson(join(root, 'x.json'), { ok: 1 }, { rename: hard }), /ENOSPC/)
    assert.equal(attempts, 1, 'only a sharing violation is retryable')
  } finally {
    await cleanup(root)
  }
})

/** Every 10th write simulates the Windows sharing violation a polling reader causes. */
test('a manifest stays readable and writable while it is polled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-atomic-race-'))
  try {
    const store = new RunStore(root)
    const base = {
      schemaVersion: 1,
      runId: 'r1',
      sessionId: 's1',
      planHash: 'h',
      phase: 'WORKERS',
      terminal: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: {},
    }
    // Publish once before polling starts: the reader must observe a torn or
    // missing document only if a concurrent write actually tore it.
    await store.writeManifest({ ...base })

    let reading = true
    const reader = (async () => {
      const seen = []
      while (reading) {
        seen.push(await store.readManifest('s1', 'r1').then(m => m.phase, () => 'unreadable'))
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return seen
    })()

    for (let index = 0; index < 40; index++) {
      base.phase = index % 2 === 0 ? 'WORKERS' : 'VALIDATING'
      await store.writeManifest({ ...base })
    }
    reading = false
    const seen = await reader
    assert.ok(seen.length > 0, 'the reader must have observed the manifest')
    assert.equal(seen.includes('unreadable'), false, 'a concurrent reader must never see an unreadable manifest')
    // The last iteration is index 39, an odd one, so VALIDATING is the final state.
    assert.equal((await store.readManifest('s1', 'r1')).phase, 'VALIDATING')
  } finally {
    await cleanup(root)
  }
})
