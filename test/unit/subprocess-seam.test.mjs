import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url)

async function filesUnder(dir) {
  const out = []
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    const next = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`
    if (entry.isDirectory()) out.push(...await filesUnder(next))
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) out.push(next)
  }
  return out
}

/**
 * The project's only subprocess seam is `execFileCaptured`.
 *
 * DSH's Windows WRITE_RESTRICTED token cannot grant a confined grandchild the
 * named-pipe client handle that libuv's piped stdio needs, so a direct
 * `execFile`/`spawn` with captured stdio fails with `spawn EPERM`. That is an
 * infrastructure failure, not a test result: when it leaked into the platform
 * lane, `npm run test:platform` reported EPERM instead of the real assertions
 * and the orchestration classified the whole validation INCONCLUSIVE. This test
 * pins the seam so the workaround cannot silently regress.
 */
test('production source reaches subprocesses only through the file-backed seam', async () => {
  const sources = await filesUnder('src/')
  const offenders = []
  for (const file of sources) {
    // The seam itself is the one legitimate owner of child_process.
    if (file === 'src/platform/captured-exec.ts') continue
    const text = await readFile(new URL(file, ROOT), 'utf8')
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/from\s+'node:child_process'/.test(stripped) || /require\(['"]node:child_process['"]\)/.test(stripped)) {
      offenders.push(file)
    }
  }
  assert.deepEqual(offenders, [], 'only src/platform/captured-exec.ts may import node:child_process')
})

test('the sandbox marker is what selects file-backed stdio, and it is set for validation', async () => {
  const captured = await readFile(new URL('src/platform/captured-exec.ts', ROOT), 'utf8')
  assert.match(captured, /env\.PLANX_SANDBOX_VALIDATION === '1'/, 'the marker must gate the file-backed branch')
  assert.match(captured, /platform === 'win32'/, 'the file-backed branch is Windows-only')

  // The validation runner must export the marker to the subprocess environment,
  // otherwise the grandchild cannot select file-backed stdio for its own spawns.
  const runner = await readFile(new URL('src/validation/runner.ts', ROOT), 'utf8')
  assert.match(runner, /PLANX_SANDBOX_VALIDATION: '1'/, 'host validation must set the marker')
  assert.match(runner, /env: preparedEnvironment\.env/, 'the marker must reach the shell request')
})

test('the platform lane never spawns a subprocess through piped stdio directly', async () => {
  const files = await filesUnder('test/platform/')
  const offenders = []
  for (const file of files) {
    const text = await readFile(new URL(file, ROOT), 'utf8')
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // `execFileSync`/`spawnSync` default to piped stdio, which is exactly the
    // shape that fails in a confined grandchild. `execFileCaptured` and an
    // explicit ignored stdio are both acceptable; a bare sync call is not.
    // stdio may be the string 'ignore' or an all-'ignore' array.
    for (const match of stripped.matchAll(/\b(?:execFileSync|spawnSync|execSync)\s*\(/g)) {
      const rest = stripped.slice(match.index)
      const end = rest.indexOf('})')
      const call = end === -1 ? rest.slice(0, 600) : rest.slice(0, end + 2)
      const ignored = /stdio:\s*(?:'ignore'|\[\s*'ignore'\s*,\s*'ignore'\s*,\s*'ignore'\s*\])/.test(call)
      if (!ignored) offenders.push(`${relative('.', file)}: ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [], 'platform tests must capture output through execFileCaptured')
})
