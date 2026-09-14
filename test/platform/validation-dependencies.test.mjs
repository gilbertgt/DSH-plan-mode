import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileCaptured } from '../../src/platform/captured-exec.ts'
import { npmCliScript } from '../../src/validation/launcher.ts'
import { materializeValidationDependencies } from '../../src/validation/dependencies.ts'

/**
 * Run one npm invocation and capture its output.
 *
 * The file-backed seam is mandatory here: under DSH's Windows WRITE_RESTRICTED
 * sandbox a confined grandchild cannot open libuv's named-pipe stdio, so
 * `execFileSync` with the default piped stdio fails with `spawn EPERM` before
 * npm ever starts. `execFileCaptured` falls back to ordinary `execFile` when no
 * sandbox marker is present, so this stays exact on every host.
 */
async function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    // Node cannot execute the npm `.cmd` shim directly through its spawn path
    // (spawnSync EINVAL), and going through the shim from cmd.exe would re-enter
    // the nested `CALL ... npm-prefix.js` step that fails under a confined
    // grandchild. Invoke the real CLI script through this process's own Node
    // binary instead, which is exactly what the validation launcher now
    // resolves to. This test exercises dependency materialization, not the
    // launcher seam covered by validation-launcher.test.mjs.
    return (await execFileCaptured(process.execPath, [npmCliScript(process.execPath), ...args], { cwd })).stdout.toString('utf8')
  }
  return (await execFileCaptured('npm', args, { cwd })).stdout.toString('utf8')
}

async function writeExecutableTool(binDir) {
  await mkdir(binDir, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'fixture-tool.cmd'), '@echo off\r\nnode -e "console.log(\'TOOLCHAIN-OK\')"\r\n')
  } else {
    const tool = join(binDir, 'fixture-tool')
    await writeFile(tool, '#!/bin/sh\necho TOOLCHAIN-OK\n')
    await chmod(tool, 0o755)
  }
}

test('fresh isolated validation workspace runs dependency imports and local toolchain from a materialized snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-deps-platform-'))
  const source = join(root, 'source')
  const validation = join(root, 'validation')
  const runDir = join(root, 'run')
  try {
    await Promise.all([mkdir(source, { recursive: true }), mkdir(validation, { recursive: true }), mkdir(runDir, { recursive: true })])
    const pkg = JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      scripts: {
        test: 'node test.mjs',
        typecheck: 'fixture-tool',
      },
    }, null, 2) + '\n'
    const lock = JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }, null, 2) + '\n'
    for (const dir of [source, validation]) {
      await writeFile(join(dir, 'package.json'), pkg)
      await writeFile(join(dir, 'package-lock.json'), lock)
    }
    await writeFile(join(validation, 'test.mjs'), "import { value } from 'fixture-dep'; console.log('DEPENDENCY='+value)\n")
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ repoRoot: source }))

    const dep = join(source, 'node_modules', 'fixture-dep')
    await mkdir(dep, { recursive: true })
    await writeFile(join(dep, 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0', type: 'module', exports: './index.js' }))
    await writeFile(join(dep, 'index.js'), "export const value = 'OK'\n")
    await writeExecutableTool(join(source, 'node_modules', '.bin'))

    await materializeValidationDependencies({ cwd: validation, runDir, manager: 'npm' })
    const imported = await runNpm(['test', '--silent'], validation)
    assert.match(imported, /DEPENDENCY=OK/)
    const toolchain = await runNpm(['run', 'typecheck', '--silent'], validation)
    assert.match(toolchain, /TOOLCHAIN-OK/)

    await writeFile(join(validation, 'node_modules', 'fixture-dep', 'index.js'), "export const value = 'MUTATED'\n")
    assert.match(await readFile(join(source, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), /value = 'OK'/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
