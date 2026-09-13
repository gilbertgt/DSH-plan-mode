import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../../src/git/repository.ts'
import { configureValidationShell, runValidation } from '../../src/validation/runner.ts'

async function fixture({ withDependencies = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'planx-wiring-'))
  const source = join(root, 'source')
  const validation = join(root, 'validation')
  const runDir = join(root, 'run')
  await Promise.all([mkdir(source, { recursive: true }), mkdir(validation, { recursive: true }), mkdir(runDir, { recursive: true })])
  const pkg = JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n'
  const lock = JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }, null, 2) + '\n'
  for (const dir of [source, validation]) {
    await writeFile(join(dir, 'package.json'), pkg)
    await writeFile(join(dir, 'package-lock.json'), lock)
  }
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ repoRoot: source }))
  if (withDependencies) {
    const dep = join(source, 'node_modules', 'fixture-dep')
    await mkdir(dep, { recursive: true })
    await writeFile(join(dep, 'index.js'), 'export const value = 1\n')
  }
  await git(validation, ['init'])
  await git(validation, ['config', 'user.email', 'test@example.com'])
  await git(validation, ['config', 'user.name', 'test'])
  await writeFile(join(validation, '.gitignore'), 'node_modules/\n')
  await git(validation, ['add', '.'])
  await git(validation, ['commit', '-m', 'base'])
  return { root, source, validation, runDir }
}

function successfulResult() {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stdout: { text: 'ok', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full', runnerFailed: false },
  }
}

test('configured host validation provisions dependencies before shell.resolve', async () => {
  const f = await fixture()
  const resolved = []
  const shell = {
    resolve(request) {
      assert.equal(existsSync(join(f.validation, 'node_modules', 'fixture-dep', 'index.js')), true, 'dependencies must exist before shell.resolve')
      resolved.push(request)
      return request
    },
    async run() { return successfulResult() },
  }
  const restore = configureValidationShell(shell)
  try {
    const receipt = await runValidation({
      cwd: f.validation,
      runDir: f.runDir,
      runId: 'wiring',
      phase: 'VALIDATING',
      commandId: 'test',
      command: 'npm test',
      timeoutMs: 3000,
      capBytes: 1024 * 1024,
    })
    assert.equal(receipt.status, 'PASS')
    assert.equal(resolved.length, 1)
    await writeFile(join(f.validation, 'node_modules', 'fixture-dep', 'index.js'), 'export const value = 2\n')
    assert.equal(await readFile(join(f.source, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), 'export const value = 1\n')
  } finally {
    restore()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('configured host validation fails before shell.resolve when source dependencies are unavailable', async () => {
  const f = await fixture({ withDependencies: false })
  let resolves = 0
  const shell = {
    resolve(request) { resolves++; return request },
    async run() { return successfulResult() },
  }
  const restore = configureValidationShell(shell)
  try {
    await assert.rejects(
      () => runValidation({
        cwd: f.validation,
        runDir: f.runDir,
        runId: 'missing-deps',
        phase: 'VALIDATING',
        commandId: 'test',
        command: 'npm test',
        timeoutMs: 3000,
        capBytes: 1024 * 1024,
      }),
      /install npm project dependencies in the originating workspace/,
    )
    assert.equal(resolves, 0)
  } finally {
    restore()
    await rm(f.root, { recursive: true, force: true })
  }
})
