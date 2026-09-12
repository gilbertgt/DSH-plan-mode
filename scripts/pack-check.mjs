import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const output = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  windowsHide: true,
})
const result = JSON.parse(output)[0]
if (!result || !Array.isArray(result.files)) throw new Error('npm pack --dry-run did not return a file manifest')
const files = new Set(result.files.map(entry => entry.path))
for (const required of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'lib/index.js', 'lib/client.js', 'profiles/worker.cordis.yml', 'profiles/reviewer.cordis.yml']) {
  if (!files.has(required)) throw new Error(`packed tarball is missing ${required}`)
}
if (pkg.version !== '1.0.0') throw new Error(`release package version must be 1.0.0, got ${pkg.version}`)
console.log(`pack layout OK (${files.size} files)`)
