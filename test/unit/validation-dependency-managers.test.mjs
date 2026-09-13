import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeValidationDependencies } from '../../src/validation/dependencies.ts'

const managers = [
  ['npm', 'package-lock.json', '{"lockfileVersion":3}\n'],
  ['pnpm', 'pnpm-lock.yaml', 'lockfileVersion: 9\n'],
  ['yarn', 'yarn.lock', '# yarn lockfile v1\n'],
  ['bun', 'bun.lock', '{"lockfileVersion":1}\n'],
]

for (const [manager, lockfile, lockBody] of managers) {
  test(`${manager} materialization selects its project lockfile without network installation`, async () => {
    const root = await mkdtemp(join(tmpdir(), `planx-${manager}-`))
    const source = join(root, 'source')
    const validation = join(root, 'validation')
    const runDir = join(root, 'run')
    try {
      await Promise.all([mkdir(source, { recursive: true }), mkdir(validation, { recursive: true }), mkdir(runDir, { recursive: true })])
      const pkg = JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }) + '\n'
      for (const dir of [source, validation]) {
        await writeFile(join(dir, 'package.json'), pkg)
        await writeFile(join(dir, lockfile), lockBody)
      }
      await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ repoRoot: source }))
      const dep = join(source, 'node_modules', 'fixture-dep')
      await mkdir(dep, { recursive: true })
      await writeFile(join(dep, 'index.js'), `export const manager = '${manager}'\n`)

      await materializeValidationDependencies({ cwd: validation, runDir, manager })
      assert.match(await readFile(join(validation, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), new RegExp(manager))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('self-contained Yarn zero-install PnP validation does not require node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planx-yarn-pnp-'))
  const source = join(root, 'source')
  const validation = join(root, 'validation')
  const runDir = join(root, 'run')
  try {
    await Promise.all([mkdir(source, { recursive: true }), mkdir(validation, { recursive: true }), mkdir(runDir, { recursive: true })])
    const pkg = JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }) + '\n'
    for (const dir of [source, validation]) {
      await writeFile(join(dir, 'package.json'), pkg)
      await writeFile(join(dir, 'yarn.lock'), '# yarn lockfile\n')
      await writeFile(join(dir, '.pnp.cjs'), 'module.exports = {}\n')
      await mkdir(join(dir, '.yarn', 'cache'), { recursive: true })
      await writeFile(join(dir, '.yarn', 'cache', 'fixture.zip'), 'fixture')
    }
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ repoRoot: source }))
    await materializeValidationDependencies({ cwd: validation, runDir, manager: 'yarn' })
    await assert.rejects(() => readFile(join(validation, 'node_modules', '.planx-validation-dependencies.json')), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
