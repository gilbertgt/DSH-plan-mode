import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  assertLockMetadata,
  assertPackageMetadata,
  assertReleaseRef,
} from './release-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = assertPackageMetadata(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

if (!existsSync(new URL('../package-lock.json', import.meta.url))) {
  throw new Error('release blocked: committed package-lock.json is required')
}
assertLockMetadata(pkg, JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')))

const status = git(['status', '--porcelain=v1', '--untracked-files=normal'])
if (status) throw new Error(`release blocked: working tree is not clean\n${status}`)

const strict = process.env.GITHUB_ACTIONS === 'true' || process.env.RELEASE_STRICT === '1'
let expectedTag
if (strict) {
  if (process.env.GITHUB_REPOSITORY !== 'gilbertgt/DSH-plan-mode') {
    throw new Error(`release blocked: unexpected repository ${process.env.GITHUB_REPOSITORY ?? '<unset>'}`)
  }
  expectedTag = assertReleaseRef(pkg.version, process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME)
  const head = git(['rev-parse', 'HEAD'])
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
    throw new Error(`release blocked: checkout HEAD ${head} != GITHUB_SHA ${process.env.GITHUB_SHA}`)
  }
}

console.log(`release source OK (${pkg.name}@${pkg.version}${strict ? `, ${expectedTag}` : ''})`)
