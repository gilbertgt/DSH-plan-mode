import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertPackageMetadata } from './release-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = assertPackageMetadata(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

if (!existsSync(new URL('../package-lock.json', import.meta.url))) {
  throw new Error('release blocked: committed package-lock.json is required')
}
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
if (lock.name !== pkg.name || lock.version !== pkg.version) {
  throw new Error(`package-lock metadata mismatch: ${lock.name}@${lock.version} != ${pkg.name}@${pkg.version}`)
}

const status = git(['status', '--porcelain=v1', '--untracked-files=normal'])
if (status) throw new Error(`release blocked: working tree is not clean\n${status}`)

const expectedTag = `v${pkg.version}`
const strict = process.env.GITHUB_ACTIONS === 'true' || process.env.RELEASE_STRICT === '1'
if (strict) {
  if (process.env.GITHUB_REPOSITORY !== 'gilbertgt/DSH-plan-mode') {
    throw new Error(`release blocked: unexpected repository ${process.env.GITHUB_REPOSITORY ?? '<unset>'}`)
  }
  if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(`release blocked: expected tag ${expectedTag}, got ${process.env.GITHUB_REF_TYPE ?? '<unset>'}:${process.env.GITHUB_REF_NAME ?? '<unset>'}`)
  }
  const head = git(['rev-parse', 'HEAD'])
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
    throw new Error(`release blocked: checkout HEAD ${head} != GITHUB_SHA ${process.env.GITHUB_SHA}`)
  }
}

console.log(`release source OK (${pkg.name}@${pkg.version}${strict ? `, ${expectedTag}` : ''})`)
