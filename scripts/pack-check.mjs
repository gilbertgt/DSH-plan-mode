import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  assertJsDependencyClosure,
  assertPackageManifest,
  assertPackageMetadata,
  scanPackageFiles,
} from './release-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = assertPackageMetadata(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath unavailable; run pack-check through npm')

const output = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})
const result = JSON.parse(output)[0]
if (!result || !Array.isArray(result.files)) throw new Error('npm pack --dry-run did not return a file manifest')
if (result.name !== pkg.name || result.version !== pkg.version) {
  throw new Error(`npm pack metadata mismatch: ${result.name}@${result.version} != ${pkg.name}@${pkg.version}`)
}

const paths = result.files.map(entry => entry.path)
assertPackageManifest(paths)
assertJsDependencyClosure(root, paths)
scanPackageFiles(root, paths)

console.log(`pack policy OK (${paths.length} files, ${pkg.name}@${pkg.version})`)
