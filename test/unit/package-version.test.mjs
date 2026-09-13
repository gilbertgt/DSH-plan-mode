import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// SemVer 2.0.0 grammar (https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions)
// reduced here, test-locally, to one anchored regular expression:
//
//   <version core>            ::= <major> "." <minor> "." <patch>
//   <numeric identifier>      ::= "0" | <positive digit> <digits>      -> 0|[1-9][0-9]*
//   <pre-release identifier>  ::= <alphanumeric identifier> | <numeric identifier>
//   <build identifier>        ::= <digits> | <alphanumeric identifier> -> [0-9A-Za-z-]+
//   <alphanumeric identifier> must contain at least one <non-digit> (<letter> | "-")
//                                                                            -> [0-9]*[A-Za-z-][0-9A-Za-z-]*
//
// The digit classes are spelled out as ASCII [0-9] so the pattern is literal and independent of
// any Unicode mode, and the pattern is anchored with plain ^...$ and therefore declared without
// the `m` flag (a newline-bearing value must never match) and without the `i` flag (an uppercase
// prefix must never match). `scripts/release-policy.mjs` deliberately keeps a looser SEMVER
// pattern for release bookkeeping; that production file is intentionally neither imported nor
// modified by this test.
const STRICT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+(?:[0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?$/

// Mirrored locally (never imported) only to prove the strict validator is strictly narrower than
// the loose release-policy pattern /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.
// `\d` is ASCII-only in JavaScript, so [0-9] is an exact mirror of the production source.
const LOOSE_RELEASE_POLICY_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// The manifest is located with new URL relative to import.meta.url instead of process.cwd() so the
// assertion targets the same root manifest when the host validates inside a detached worktree.
// Neither the read nor the parse is guarded and no fallback value is substituted: a missing or
// unparsable manifest must fail the run loudly instead of being swallowed.
const liveManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

function isStrictSemver(value) {
  return typeof value === 'string' && STRICT_SEMVER.test(value)
}

function typeLabel(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertPackageVersion(pkg) {
  assert.ok(
    pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg),
    `package metadata must be a parsed package.json object, received ${typeLabel(pkg)}`,
  )
  assert.ok(Object.hasOwn(pkg, 'version'), 'package metadata is missing the version own property')
  assert.equal(
    typeof pkg.version,
    'string',
    `package version must be a string, received ${typeLabel(pkg.version)}`,
  )
  assert.ok(
    isStrictSemver(pkg.version),
    `package version must be a strict SemVer 2.0.0 string, received ${JSON.stringify(pkg.version)}`,
  )
  return pkg.version
}

function captureError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

function assertAccepted(values) {
  for (const value of values) {
    assert.equal(isStrictSemver(value), true, `expected strict SemVer to accept ${JSON.stringify(value)}`)
  }
}

function assertRejected(values) {
  for (const value of values) {
    assert.equal(isStrictSemver(value), false, `expected strict SemVer to reject ${JSON.stringify(value)}`)
  }
}

test('root package.json declares a version that is an own, strict SemVer 2.0.0 string', () => {
  assert.ok(Object.hasOwn(liveManifest, 'version'), 'root package.json must declare a version own property')
  assert.equal(typeof liveManifest.version, 'string', 'root package.json version must be a string')
  assert.equal(
    isStrictSemver(liveManifest.version),
    true,
    `root package.json version must be a strict SemVer 2.0.0 string, received ${JSON.stringify(liveManifest.version)}`,
  )
  assert.equal(assertPackageVersion(liveManifest), liveManifest.version, 'assertPackageVersion must return the version unchanged')
  assert.equal(liveManifest.version, liveManifest.version.trim(), 'the declared version must not carry surrounding whitespace')
})

test('strict validator accepts release, prerelease and build metadata forms', () => {
  assertAccepted([
    '0.0.0',
    '1.2.3',
    '1.0.10',
    '10.20.30',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0-x-y-z.--',
    '1.0.0-alpha+001',
    '1.0.0-rc.1+build.1',
    '1.0.0+20130313144700',
    '1.0.0-beta+exp.sha.5114f85',
    '1.0.0+21AF26D3---117B344092BD',
  ])
})

test('strict validator rejects malformed cores, prefixed, padded and non-numeric values', () => {
  assertRejected([
    '',
    '1',
    '1.2',
    '1.2.',
    '.1.2.3',
    '1..2.3',
    '1.2.3.4',
    '1.2.-3',
  ])
  assertRejected([
    'v1.2.3',
    'V1.2.3',
    '=1.2.3',
    '^1.2.3',
    '~1.2.3',
    '>=1.2.3',
    'v 1.2.3',
    '1.2.3v',
    ' 1.2.3',
    '1.2.3 ',
    '\t1.2.3',
    '1.2.3\t',
  ])
  assertRejected([
    'a.b.c',
    'one.two.three',
    '1.2.x',
    'x.2.3',
    '1.x.3',
    '1.2.3alpha',
  ])
})

test('strict validator rejects empty identifiers, leading zeros and illegal characters', () => {
  assertRejected([
    '1.2.3-',
    '1.2.3+',
    '1.2.3-.alpha',
    '1.2.3-alpha.',
    '1.2.3-alpha..1',
    '1.2.3+.alpha',
    '1.2.3+build.',
    '1.2.3+build..1',
  ])
  assertRejected([
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '00.0.0',
    '0000000000.0.0',
    '1.0.0-01',
    '1.0.0-00',
    '1.0.0-alpha.01',
    '1.0.0-0.3.07',
    '1.0.0-01.02.03',
  ])
  assertRejected([
    '1.2.3-alpha_1',
    '1.2.3-alpha 1',
    '1.2.3-alpha@1',
    '1.2.3-alpha/1',
    '1.2.3+build_1',
    '1.2.3+build:1',
    '1.2.3+bu ild',
    '1.2.3-\u03b1',
    '\uff11.2.3',
  ])
})

test('strict validator keeps full-string anchoring and rejects newline-bearing values', () => {
  // Negative control: the same source WITH the multiline flag would accept these values, so the
  // cases below genuinely pin down the absence of `m` rather than merely re-testing `$`.
  const multilineControl = new RegExp(STRICT_SEMVER.source, 'm')
  for (const value of ['1.2.3\n', '1.2.3\r', '1.2.3\n2.0.0', '1.2.3\nGARBAGE', '1.2.3+build.1\n']) {
    assert.equal(multilineControl.test(value), true, `multiline control should match ${JSON.stringify(value)}`)
    assert.equal(isStrictSemver(value), false, `strict SemVer must reject ${JSON.stringify(value)}`)
  }
  assertRejected(['1.2\n.3'])
  assert.equal(STRICT_SEMVER.flags, '', 'the strict validator must not carry the m or i flags')
})

test('assertPackageVersion fails closed on missing or non-object package metadata', () => {
  // The guard has to spell out `null` and arrays explicitly: `typeof null === 'object'` and an
  // array is an object too, so a bare typeof check would silently accept both shapes.
  const invalidMetadata = [
    ['undefined', undefined],
    ['null', null],
    ['a bare string', '1.0.10'],
    ['a bare number', 10010],
    ['an array', ['1.0.10']],
    ['an empty array', []],
  ]
  for (const [label, value] of invalidMetadata) {
    assert.throws(
      () => assertPackageVersion(value),
      /package metadata must be a parsed package\.json object/,
      `expected ${label} to fail closed`,
    )
  }
})

test('assertPackageVersion fails closed on a missing version own property', () => {
  assert.throws(() => assertPackageVersion({}), /missing the version own property/)
  assert.throws(() => assertPackageVersion({ name: 'fixture' }), /missing the version own property/)
  // An inherited version is not an own property, so it must not be trusted.
  assert.throws(
    () => assertPackageVersion(Object.create({ version: '1.0.10' })),
    /missing the version own property/,
  )
})

test('assertPackageVersion fails closed on non-string version values with a distinct message', () => {
  const nonStringVersions = [
    ['an undefined version', undefined],
    ['a null version', null],
    ['a numeric version', 10010],
    ['a floating point version', 1.01],
    ['a boolean version', true],
    ['an object version', {}],
    ['an array version', ['1.0.10']],
    ['a boxed string version', new String('1.0.10')],
  ]
  for (const [label, value] of nonStringVersions) {
    assert.throws(
      () => assertPackageVersion({ version: value }),
      /package version must be a string/,
      `expected ${label} to fail closed`,
    )
  }

  const missingError = captureError(() => assertPackageVersion({}))
  const nonStringError = captureError(() => assertPackageVersion({ version: 10010 }))
  const nonStrictError = captureError(() => assertPackageVersion({ version: '01.0.10' }))
  assert.match(missingError.message, /missing the version own property/)
  assert.doesNotMatch(missingError.message, /must be a string/)
  assert.match(nonStringError.message, /must be a string/)
  assert.doesNotMatch(nonStringError.message, /missing the version own property/)
  assert.match(nonStrictError.message, /must be a strict SemVer 2\.0\.0 string/)
  assert.doesNotMatch(nonStrictError.message, /must be a string, received/)

  assert.equal(assertPackageVersion({ version: '1.0.10' }), '1.0.10')
  assert.equal(assertPackageVersion({ name: 'fixture', version: '2.0.0-rc.1+build.7' }), '2.0.0-rc.1+build.7')
})

test('live package metadata fails closed on absent, non-string and non-strict versions', () => {
  const { version, ...manifestWithoutVersion } = liveManifest
  assert.equal(version, liveManifest.version)
  assert.ok(isStrictSemver(version), 'this guard only proves a fresh failure when the live version is strict')
  assert.throws(() => assertPackageVersion(manifestWithoutVersion), /missing the version own property/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: undefined }), /package version must be a string/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: 10010 }), /package version must be a string/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: `0${version}` }), /must be a strict SemVer 2\.0\.0 string/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: `${version}-01` }), /must be a strict SemVer 2\.0\.0 string/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: `v${version}` }), /must be a strict SemVer 2\.0\.0 string/)
  assert.throws(() => assertPackageVersion({ ...liveManifest, version: `${version}\n` }), /must be a strict SemVer 2\.0\.0 string/)
})

test('strict validator rejects leading-zero and empty-identifier forms the loose release policy accepts', () => {
  // scripts/release-policy.mjs is intentionally NOT imported or modified here: its loose SEMVER
  // pattern is mirrored above purely to document that the strict validator is narrower than it.
  const strictRejectsLooseAccepts = [
    '01.0.10',
    '0.0.010',
    '0000000000.0.0',
    '1.0.0-01',
    '1.0.0-00',
    '1.0.0-0.3.07',
    '1.0.0-01.02.03',
    '1.0.0-alpha..1',
    '1.0.0-alpha.',
    '1.0.0-.alpha',
    '1.0.0+build..1',
    '1.0.0+001.',
  ]
  for (const value of strictRejectsLooseAccepts) {
    assert.equal(LOOSE_RELEASE_POLICY_SEMVER.test(value), true, `loose release-policy regex should accept ${JSON.stringify(value)}`)
    assert.equal(isStrictSemver(value), false, `strict SemVer must reject ${JSON.stringify(value)}`)
  }
  for (const value of [liveManifest.version, '1.2.3', '1.0.0-rc.1+build.1']) {
    assert.equal(LOOSE_RELEASE_POLICY_SEMVER.test(value), true, `loose release-policy regex should accept ${JSON.stringify(value)}`)
    assert.equal(isStrictSemver(value), true, `strict SemVer must accept ${JSON.stringify(value)}`)
  }
})
