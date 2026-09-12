import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  assertJsDependencyClosure,
  assertPackageManifest,
  assertPackageMetadata,
  scanPackageFiles,
  stripTarPackagePrefix,
} from './release-policy.mjs'

await import('./release-source-check.mjs')

const root = fileURLToPath(new URL('..', import.meta.url))
const artifacts = join(root, '.artifacts')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath unavailable; run release-pack through npm')

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
}

npm(['run', 'build'])
npm(['run', 'pack:check'])

rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const packedRaw = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts], { capture: true })
const packed = JSON.parse(packedRaw)[0]
if (!packed?.filename || !Array.isArray(packed.files)) throw new Error('npm pack did not return an artifact manifest')

const pkg = assertPackageMetadata(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
if (packed.name !== pkg.name || packed.version !== pkg.version) {
  throw new Error(`packed metadata mismatch: ${packed.name}@${packed.version} != ${pkg.name}@${pkg.version}`)
}

const npmManifest = packed.files.map(entry => entry.path)
assertPackageManifest(npmManifest)
assertJsDependencyClosure(root, npmManifest)
scanPackageFiles(root, npmManifest)

const tarball = join(artifacts, basename(packed.filename))
const tarList = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8', windowsHide: true })
  .split(/\r?\n/)
  .filter(Boolean)
const tarManifest = stripTarPackagePrefix(tarList)
assertPackageManifest(tarManifest)

const npmSet = new Set(npmManifest)
const tarSet = new Set(tarManifest)
if (npmSet.size !== tarSet.size || [...npmSet].some(path => !tarSet.has(path))) {
  throw new Error('actual tarball manifest differs from npm pack manifest')
}

const extracted = mkdtempSync(join(tmpdir(), 'dsh-plan-release-'))
try {
  execFileSync('tar', ['-xzf', tarball, '-C', extracted], { windowsHide: true, stdio: 'inherit' })
  const packageRoot = join(extracted, 'package')
  assertJsDependencyClosure(packageRoot, tarManifest)
  scanPackageFiles(packageRoot, tarManifest)
  const extractedPkg = assertPackageMetadata(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')))
  if (extractedPkg.name !== pkg.name || extractedPkg.version !== pkg.version) throw new Error('extracted package metadata mismatch')

  const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-plan-install-'))
  try {
    writeFileSync(join(smokeRoot, 'package.json'), JSON.stringify({ private: true }, null, 2))
    npm([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      '--omit=optional',
      tarball,
    ], { cwd: smokeRoot })
    const installed = join(smokeRoot, 'node_modules', '@gilbertgt', 'dsh-plan-orchestrator')
    assertPackageMetadata(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')))
    assertJsDependencyClosure(installed, tarManifest)
    for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
      readFileSync(join(installed, ...required.split('/')))
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true })
  }
} finally {
  rmSync(extracted, { recursive: true, force: true })
}

const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const manifest = {
  schemaVersion: 1,
  package: pkg.name,
  version: pkg.version,
  tarball: basename(tarball),
  sha256,
  files: [...tarSet].sort(),
  gitSha: process.env.GITHUB_SHA ?? null,
  gitRef: process.env.GITHUB_REF ?? null,
  generatedAt: new Date().toISOString(),
}
writeFileSync(join(artifacts, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`verified release artifact ${manifest.tarball}`)
console.log(`sha256 ${sha256}`)
