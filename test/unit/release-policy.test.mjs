import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertLockMetadata,
  assertPackageManifest,
  assertPackageMetadata,
  assertReleaseRef,
  scanSensitiveText,
  stripTarPackagePrefix,
} from '../../scripts/release-policy.mjs'

const validManifest = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'compatibility.json',
  'profiles/worker.cordis.yml',
  'profiles/reviewer.cordis.yml',
  'lib/index.js',
  'lib/client.js',
]

const validPkg = {
  name: '@gilbertgt/dsh-plan-orchestrator',
  version: '1.2.3',
  main: './lib/index.js',
  exports: { '.': './lib/index.js', './client': './lib/client.js' },
  publishConfig: { access: 'public' },
  repository: { type: 'git', url: 'git+https://github.com/gilbertgt/DSH-plan-mode.git' },
}

test('package manifest is fail-closed', () => {
  assert.doesNotThrow(() => assertPackageManifest(validManifest))
  for (const forbidden of [
    'src/index.ts',
    'lib/client.js.map',
    '.env',
    '.npmrc',
    'private.key',
    'archive.tgz',
    'test/fixture.json',
    'lib/unexpected.js',
  ]) {
    assert.throws(() => assertPackageManifest([...validManifest, forbidden]), /unexpected package file/)
  }
  assert.throws(() => assertPackageManifest(validManifest.filter(path => path !== 'lib/index.js')), /missing lib\/index\.js/)
})

test('package metadata accepts future versions without hard-coding 1.0.0', () => {
  assert.equal(assertPackageMetadata(validPkg).version, '1.2.3')
  assert.equal(assertPackageMetadata({ ...validPkg, version: '2.0.0-rc.1' }).version, '2.0.0-rc.1')
  assert.throws(() => assertPackageMetadata({ ...validPkg, version: 'banana' }), /invalid package version/)
  assert.throws(() => assertPackageMetadata({ ...validPkg, publishConfig: undefined }), /publishConfig\.access must be public/)
  assert.throws(
    () => assertPackageMetadata({ ...validPkg, repository: { url: 'https://github.com/example/wrong.git' } }),
    /unexpected package repository URL/,
  )
})

test('lock metadata and release tag must match package version', () => {
  assert.doesNotThrow(() => assertLockMetadata(validPkg, { name: validPkg.name, version: validPkg.version }))
  assert.throws(() => assertLockMetadata(validPkg, { name: validPkg.name, version: '1.2.4' }), /package-lock metadata mismatch/)
  assert.equal(assertReleaseRef(validPkg.version, 'tag', 'v1.2.3'), 'v1.2.3')
  assert.throws(() => assertReleaseRef(validPkg.version, 'branch', 'main'), /expected tag v1\.2\.3/)
  assert.throws(() => assertReleaseRef(validPkg.version, 'tag', 'v1.2.4'), /expected tag v1\.2\.3/)
})

test('scanner catches high-confidence credentials and private key material', () => {
  assert.throws(() => scanSensitiveText('-----BEGIN PRIVATE KEY-----\nabc', 'key.pem'), /private key/)
  assert.throws(() => scanSensitiveText(`value=ghp_${'A'.repeat(36)}`, 'bundle.js'), /GitHub token/)
  assert.throws(() => scanSensitiveText(`value=npm_${'B'.repeat(36)}`, 'bundle.js'), /npm token/)
  assert.throws(() => scanSensitiveText(`value=AKIA${'C'.repeat(16)}`, 'bundle.js'), /AWS access key/)
  assert.throws(() => scanSensitiveText(`value=sk-proj-${'E'.repeat(32)}`, 'bundle.js'), /OpenAI-style API key/)
  assert.throws(() => scanSensitiveText(`value=AIza${'F'.repeat(35)}`, 'bundle.js'), /Google API key/)
  assert.throws(() => scanSensitiveText(`Authorization: Bearer ${'D'.repeat(32)}`, 'bundle.js'), /Bearer credential/)
  assert.throws(() => scanSensitiveText(`api_key='${'G'.repeat(32)}'`, 'bundle.js'), /credential assignment/)
})

test('scanner catches local user-home paths without rejecting harmless terminology', () => {
  assert.throws(() => scanSensitiveText('C:\\Users\\alice\\project\\file.ts', 'bundle.js'), /Windows user-home path/)
  assert.throws(() => scanSensitiveText('/Users/alice/project/file.ts', 'bundle.js'), /macOS user-home path/)
  assert.throws(() => scanSensitiveText('/home/alice/project/file.ts', 'bundle.js'), /Linux user-home path/)
  assert.doesNotThrow(() => scanSensitiveText('tokenBudget passwordField secretScanner C:\\path\\to\\project', 'bundle.js'))
})

test('tar manifest rejects traversal and strips package prefix', () => {
  assert.deepEqual(
    stripTarPackagePrefix(['package/', 'package/lib/', 'package/package.json', 'package/lib/index.js']),
    ['package.json', 'lib/index.js'],
  )
  assert.throws(() => stripTarPackagePrefix(['package/../escape']), /unsafe tar entry/)
  assert.throws(() => stripTarPackagePrefix(['/absolute']), /unsafe tar entry/)
})
