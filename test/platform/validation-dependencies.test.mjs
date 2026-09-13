import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeValidationDependencies } from '../../src/validation/dependencies.ts'

function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    // Node does not execute .cmd files directly through execFileSync on current
    // Windows releases (spawnSync EINVAL). This test exercises dependency
    // materialization, not the PowerShell launcher seam covered separately by
    // validation-launcher.test.mjs, so invoke the npm.cmd shim through ComSpec.
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
    return execFileSync(comspec, ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], {
      cwd, encoding: 'utf8', windowsHide: true,
    })
  }
  return execFileSync('npm', args, { cwd, encoding: 'utf8' })
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
    const imported = runNpm(['test', '--silent'], validation)
    assert.match(imported, /DEPENDENCY=OK/)
    const toolchain = runNpm(['run', 'typecheck', '--silent'], validation)
    assert.match(toolchain, /TOOLCHAIN-OK/)

    await writeFile(join(validation, 'node_modules', 'fixture-dep', 'index.js'), "export const value = 'MUTATED'\n")
    assert.match(await readFile(join(source, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), /value = 'OK'/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
