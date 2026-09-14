import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, fullHead } from '../../src/git/repository.ts'
import { createWorktree, removeOwnedWorktree } from '../../src/git/worktrees.ts'
import { capturePatch } from '../../src/git/patches.ts'
import { pathFingerprints } from '../../src/git/fingerprints.ts'
import { applyPatchArtifact } from '../../src/orchestration/integrator.ts'

const cleanup = root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-parallel-recovery-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'test'])
  // This host's system Git sets `core.autocrlf=true`, which rewrites the
  // fixture's LF endings on checkout. Pin the fixture to store bytes verbatim so
  // the assertions below compare content rather than a line-ending policy.
  await git(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, 'a.ts'), 'base-a\n')
  await writeFile(join(root, 'b.ts'), 'base-b\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

const RUN = '4429470e-48ca-4a81-8eec-caca0eafb1c5'

/**
 * A resumed parallel run reuses the deterministic lease path. A worktree that
 * survived a crash makes the next `git worktree add` fail on an existing
 * directory, so resume could never reach the Worker at all.
 */
test('a crashed parallel lease is reclaimed so the same run can resume', async () => {
  const root = await repo()
  const state = await mkdtemp(join(tmpdir(), 'planx-parallel-state-'))
  try {
    const head = await fullHead(root)
    const first = await createWorktree(root, `${RUN}-worktrees`, 't1', head, state)
    // The crash left the lease registered and its directory behind.
    await writeFile(join(first.path, 'a.ts'), 'worker-a\n')
    assert.equal((await stat(first.path)).isDirectory(), true)

    const resumed = await createWorktree(root, `${RUN}-worktrees`, 't1', head, state)
    assert.equal(resumed.path, first.path, 'the lease path is deterministic across a resume')
    // The reclaimed lease is a clean checkout of the recorded head, not the
    // crashed worker's partial state.
    assert.equal(await readFile(join(resumed.path, 'a.ts'), 'utf8'), 'base-a\n')

    await removeOwnedWorktree(root, resumed, true)
  } finally {
    await cleanup(root)
    await cleanup(state)
  }
})

/**
 * A patch is captured in an isolated lease and written into the main tree much
 * later. When the user edits an owned file in that window, the patch used to
 * overwrite the edit silently.
 */
test('a patch refuses to overwrite an owned file the user changed after the host read it', async () => {
  const root = await repo()
  const state = await mkdtemp(join(tmpdir(), 'planx-parallel-cas-'))
  try {
    const head = await fullHead(root)
    const lease = await createWorktree(root, `${RUN}-worktrees`, 't1', head, state)
    await writeFile(join(lease.path, 'a.ts'), 'worker-a\n')
    const patch = await capturePatch(lease.path, head, 't1', ['a.ts'])

    // The host read the target, then the user edited it before the patch landed.
    const expected = await pathFingerprints(root, ['a.ts'])
    await writeFile(join(root, 'a.ts'), 'user edit\n')

    await assert.rejects(
      () => applyPatchArtifact(root, patch, ['a.ts'], { expected }),
      /working tree changed after the host read it/,
    )
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'user edit\n', 'the user edit must survive')

    // With the tree unchanged the same patch still applies.
    const settled = await pathFingerprints(root, ['a.ts'])
    await applyPatchArtifact(root, patch, ['a.ts'], { expected: settled })
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'worker-a\n')

    await removeOwnedWorktree(root, lease, true)
  } finally {
    await cleanup(root)
    await cleanup(state)
  }
})

/**
 * Two tasks in one wave must both land. The shared `worktrees.json` writer is
 * serialized so a slower writer cannot revert a sibling's newer status.
 */
test('two disjoint parallel tasks apply their patches independently', async () => {
  const root = await repo()
  const state = await mkdtemp(join(tmpdir(), 'planx-parallel-wave-'))
  try {
    const head = await fullHead(root)
    const leases = [
      await createWorktree(root, `${RUN}-worktrees`, 't1', head, state),
      await createWorktree(root, `${RUN}-worktrees`, 't2', head, state),
    ]
    await writeFile(join(leases[0].path, 'a.ts'), 'worker-a\n')
    await writeFile(join(leases[1].path, 'b.ts'), 'worker-b\n')
    const patches = [
      await capturePatch(leases[0].path, head, 't1', ['a.ts']),
      await capturePatch(leases[1].path, head, 't2', ['b.ts']),
    ]

    for (const [index, patch] of patches.entries()) {
      const targets = patch.files.map(file => file.path)
      const expected = await pathFingerprints(root, targets)
      await applyPatchArtifact(root, patch, ['a.ts', 'b.ts'], { expected })
      await removeOwnedWorktree(root, leases[index], true)
    }

    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'worker-a\n')
    assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'worker-b\n')
  } finally {
    await cleanup(root)
    await cleanup(state)
  }
})
