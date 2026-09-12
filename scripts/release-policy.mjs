import { lstatSync, readFileSync } from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'

export const PACKAGE_NAME = '@gilbertgt/dsh-plan-orchestrator'

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'compatibility.json',
  'profiles/worker.cordis.yml',
  'profiles/reviewer.cordis.yml',
  'lib/index.js',
  'lib/client.js',
])

const EXACT_ALLOWED = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'compatibility.json',
  'profiles/worker.cordis.yml',
  'profiles/reviewer.cordis.yml',
])

const BUILD_ENTRYPOINTS = Object.freeze(['lib/index.js', 'lib/client.js'])
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LOCAL_JS_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.\.?\/[^"']+\.js)["']/g

const SENSITIVE_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Bearer credential', /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['npm auth token config', /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\s${}]{12,}/i],
  ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'`][A-Za-z0-9._~+/=-]{24,}["'`]/i],
  ['Windows user-home path', /\b[A-Za-z]:\\Users\\[^\\\r\n]+\\/],
  ['macOS user-home path', /\/Users\/[^/\s]+\//],
  ['Linux user-home path', /\/home\/[^/\s]+\//],
])

function normalizedPackagePath(input) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('package path must be a non-empty string')
  if (input.includes('\\')) throw new Error(`package path must use forward slashes: ${input}`)
  if (input.startsWith('/') || input === '..' || input.startsWith('../') || input.includes('/../')) {
    throw new Error(`unsafe package path: ${input}`)
  }
  if (input === '.' || input.startsWith('./') || input.includes('/./')) throw new Error(`non-canonical package path: ${input}`)
  return input
}

function isBuildJsPath(path) {
  return /^lib\/[^/]+\.js$/.test(path)
}

export function isAllowedPackagePath(input) {
  const path = normalizedPackagePath(input)
  return EXACT_ALLOWED.has(path) || isBuildJsPath(path)
}

export function assertPackageManifest(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('package manifest is empty')
  const seen = new Set()
  for (const raw of paths) {
    const path = normalizedPackagePath(raw)
    if (seen.has(path)) throw new Error(`duplicate package entry: ${path}`)
    seen.add(path)
    if (!isAllowedPackagePath(path)) throw new Error(`unexpected package file: ${path}`)
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!seen.has(required)) throw new Error(`packed tarball is missing ${required}`)
  }
  return seen
}

export function assertJsDependencyClosure(root, paths) {
  const manifestJs = new Set(paths.map(normalizedPackagePath).filter(isBuildJsPath))
  const visited = new Set()
  const queue = [...BUILD_ENTRYPOINTS]

  while (queue.length) {
    const path = queue.shift()
    if (visited.has(path)) continue
    if (!manifestJs.has(path)) throw new Error(`build graph entry missing from package: ${path}`)
    visited.add(path)

    const text = readFileSync(resolve(root, ...path.split('/')), 'utf8')
    LOCAL_JS_REFERENCE.lastIndex = 0
    for (let match = LOCAL_JS_REFERENCE.exec(text); match; match = LOCAL_JS_REFERENCE.exec(text)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]))
      if (!isBuildJsPath(target)) throw new Error(`unsafe local JS reference from ${path}: ${match[1]}`)
      if (!manifestJs.has(target)) throw new Error(`referenced build chunk missing from package: ${target}`)
      if (!visited.has(target)) queue.push(target)
    }
  }

  const orphans = [...manifestJs].filter(path => !visited.has(path)).sort()
  if (orphans.length) throw new Error(`unreferenced build chunk(s): ${orphans.join(', ')}`)
  return visited
}

export function assertPackageMetadata(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('package metadata is missing')
  if (pkg.name !== PACKAGE_NAME) throw new Error(`unexpected package name: ${pkg.name}`)
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) throw new Error(`invalid package version: ${pkg.version}`)
  if (pkg.private === true) throw new Error('release package must not be private')
  if (pkg.publishConfig?.access !== 'public') throw new Error('publishConfig.access must be public')
  if (pkg.main !== './lib/index.js') throw new Error(`unexpected package main: ${pkg.main}`)
  if (pkg.exports?.['.'] !== './lib/index.js' || pkg.exports?.['./client'] !== './lib/client.js') {
    throw new Error('package exports do not point at the expected built entry points')
  }
  if (pkg.repository?.url !== 'git+https://github.com/gilbertgt/DSH-plan-mode.git') {
    throw new Error(`unexpected package repository URL: ${pkg.repository?.url}`)
  }
  return pkg
}

export function assertLockMetadata(pkg, lock) {
  if (!lock || typeof lock !== 'object') throw new Error('package-lock metadata is missing')
  if (lock.name !== pkg.name || lock.version !== pkg.version) {
    throw new Error(`package-lock metadata mismatch: ${lock.name}@${lock.version} != ${pkg.name}@${pkg.version}`)
  }
  return lock
}

export function assertReleaseRef(version, refType, refName) {
  const expected = `v${version}`
  if (refType !== 'tag' || refName !== expected) {
    throw new Error(`release blocked: expected tag ${expected}, got ${refType ?? '<unset>'}:${refName ?? '<unset>'}`)
  }
  return expected
}

export function scanSensitiveText(text, label = '<text>') {
  if (typeof text !== 'string') throw new Error(`cannot scan non-text content: ${label}`)
  if (text.includes('\u0000')) throw new Error(`binary/NUL content is not allowed in release text file: ${label}`)
  for (const [name, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) throw new Error(`sensitive ${name} detected in ${label}`)
  }
}

export function scanPackageFiles(root, paths) {
  const rootAbs = resolve(root)
  for (const raw of paths) {
    const path = normalizedPackagePath(raw)
    const absolute = resolve(rootAbs, ...path.split('/'))
    const rel = relative(rootAbs, absolute)
    if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith('/') || rel.startsWith('\\')) {
      throw new Error(`package file escapes scan root: ${path}`)
    }
    const stat = lstatSync(absolute)
    if (!stat.isFile()) throw new Error(`package entry is not a regular file: ${path}`)
    scanSensitiveText(readFileSync(absolute, 'utf8'), path)
  }
}

export function stripTarPackagePrefix(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('tarball contains no entries')
  const paths = []
  for (const raw of entries) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (raw.includes('\\') || raw.startsWith('/') || raw.includes('../')) throw new Error(`unsafe tar entry: ${raw}`)
    if (raw === 'package/' || raw === 'package' || raw.endsWith('/')) continue
    if (!raw.startsWith('package/')) throw new Error(`tar entry missing package/ prefix: ${raw}`)
    const stripped = raw.slice('package/'.length)
    if (stripped) paths.push(stripped)
  }
  return paths
}
