import { lstatSync, readFileSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

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

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const SENSITIVE_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Bearer credential', /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['npm auth token config', /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\s${}]{12,}/i],
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

export function isAllowedPackagePath(input) {
  const path = normalizedPackagePath(input)
  return EXACT_ALLOWED.has(path) || /^lib\/[^/]+\.js$/.test(path)
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
  return pkg
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
