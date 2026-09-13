import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeValidationDependencies } from '../../src/validation/dependencies.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'planx-deps-'))
  const source = join(root, 'source')
  const validation = join(root, 'validation')
  const runDir = join(root, 'run')
  await Promise.all([mkdir(source, { recursive: true }), mkdir(validation, { recursive: true }), mkdir(runDir, { recursive: true })])
  const pkg = JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node test.mjs', typecheck: 'fixture-tsc' } }, null, 2) + '\n'
  const lock = JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }, null, 2) + '\n'
  for (const dir of [source, validation]) {
    await writeFile(join(dir, 'package.json'), pkg)
    await writeFile(join(dir, 'package-lock.json'), lock)
  }
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ repoRoot: source }))
  return { root, source, validation, runDir }
}

test('materialization creates an isolated dependency snapshot and reuses only a matching marker', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.source, 'node_modules', 'fixture-dep'), { recursive: true })
    await writeFile(join(f.source, 'node_modules', 'fixture-dep', 'index.js'), 'export const value = 1\n')
    await materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' })
    assert.equal(await readFile(join(f.validation, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), 'export const value = 1\n')

    await writeFile(join(f.validation, 'node_modules', 'fixture-dep', 'index.js'), 'export const value = 2\n')
    assert.equal(await readFile(join(f.source, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), 'export const value = 1\n', 'validation writes must not reach the originating dependency tree')

    await materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' })
    await writeFile(join(f.source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(join(f.validation, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await assert.rejects(
      () => materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'pnpm' }),
      /snapshot does not match the current package manager or lockfile/,
    )
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('materialization fails closed when dependency inputs differ or source dependencies are unavailable', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      () => materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' }),
      /install npm project dependencies in the originating workspace/,
    )

    await mkdir(join(f.source, 'node_modules'), { recursive: true })
    await writeFile(join(f.validation, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}\n')
    await assert.rejects(
      () => materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' }),
      /dependency inputs differ from originating workspace/,
    )
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('dependency links are remapped inside the validation worktree and external escapes are rejected', async t => {
  const f = await fixture()
  try {
    const workspace = join(f.source, 'packages', 'local-dep')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'index.js'), 'export const local = true\n')
    await mkdir(join(f.source, 'node_modules'), { recursive: true })
    try {
      await symlink(workspace, join(f.source, 'node_modules', 'local-dep'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks unavailable on this host: ${error.message}`)
      return
    }

    await mkdir(join(f.validation, 'packages', 'local-dep'), { recursive: true })
    await writeFile(join(f.validation, 'packages', 'local-dep', 'index.js'), 'export const local = "validation"\n')
    await materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' })
    assert.match(await readFile(join(f.validation, 'node_modules', 'local-dep', 'index.js'), 'utf8'), /validation/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('dependency links that resolve outside the originating repository fail closed', async t => {
  const f = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'planx-deps-outside-'))
  try {
    await mkdir(join(f.source, 'node_modules'), { recursive: true })
    await writeFile(join(outside, 'index.js'), 'export default 1\n')
    try {
      await symlink(outside, join(f.source, 'node_modules', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlinks unavailable on this host: ${error.message}`)
      return
    }
    await assert.rejects(
      () => materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' }),
      /link escapes originating repository/,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('dependency materialization preserves executable file mode on POSIX', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  try {
    const bin = join(f.source, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const tool = join(bin, 'fixture-tool')
    await writeFile(tool, '#!/bin/sh\nexit 0\n')
    await chmod(tool, 0o755)
    await materializeValidationDependencies({ cwd: f.validation, runDir: f.runDir, manager: 'npm' })
    const copied = await import('node:fs/promises').then(fs => fs.stat(join(f.validation, 'node_modules', '.bin', 'fixture-tool')))
    assert.equal(copied.mode & 0o111, 0o111)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
