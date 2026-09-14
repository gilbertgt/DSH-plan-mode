import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, matchesGlob } from 'node:path'

/**
 * Package entry-point contract for the root manifest.
 *
 * Everything below is read from the live manifest and the filesystem only. The
 * DSH packages that own the consumer side are deliberately NOT imported —
 * `@deepseek-ai/dsh-client-modules` (which reads `dsh.client` and
 * `exports["./client"]`) and `@deepseek-ai/dsh-package-manifest`/`dsh-app-boot`
 * (which read `dsh.bundle.patch`) — so these assertions keep describing the
 * declared contract instead of whatever the installed implementation happens to
 * do today. The mirrored semantics, for orientation:
 *
 *  - `dsh-app-boot`'s `loadProfileDirectory` reads `dsh.bundle.patch` from the
 *    package manifest and joins it onto the package directory
 *    (`join(packageDir, declared)`), then parses that file as the overlay patch
 *    layer. The value must therefore be a non-empty relative string naming the
 *    shipped patch file.
 *  - `dsh-client-modules`' `clientExportOf` accepts `exports["./client"]` either
 *    as a plain string or as an object whose `default` member is a string, throws
 *    for every other shape, and then resolves the bundle with
 *    `join(dirname(packagePath), clientRel)`. Its node half later serves that
 *    bundle to the web client as `/plugins/<package-name>/client.js`, so the
 *    target has to be a `./`-relative path inside this package. Its
 *    `parseDshClient` requires a string `dsh.client.platform` and, when present,
 *    a string array `dsh.client.inject`.
 *  - npm always packs `package.json`, `README.md`, `LICENSE`/`LICENCE` and the
 *    `main` file regardless of `files`; every other shipped file must be matched
 *    by a `files` pattern. Only `package.json` is treated as covered by that
 *    always-included rule here; `main` still has to be matched by a pattern.
 *
 * `lib/` is the gitignored build output (see `.gitignore`), yet nothing in this
 * lane is skipped or downgraded because of that: the entry points this manifest
 * publishes are exactly the thing under contract, so `main` and every export
 * target are asserted to exist on disk in every environment.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MANIFEST_PATH = fileURLToPath(new URL('../../package.json', import.meta.url))
const MAIN_TARGET = './lib/index.js'
const CLIENT_TARGET = './lib/client.js'
const PATCH_TARGET = './cordis.patch.yml'
const CLIENT_PLATFORM = 'web'

/** The entry points this package documents for consumers. */
const DOCUMENTED_EXPORTS = Object.freeze([
  ['.', MAIN_TARGET],
  ['./client', CLIENT_TARGET],
  ['./cordis.patch.yml', PATCH_TARGET],
  ['./package.json', './package.json'],
])

/**
 * The always-packed names of the npm `files` rule. The exemption is bounded to
 * these names: `main` is deliberately absent from this list because npm's
 * `main`-file exemption is not what this manifest is allowed to rely on — the
 * `lib/*.js` pattern has to cover it, which the coverage test below pins.
 */
const NPM_ALWAYS_INCLUDED = Object.freeze(['package.json', 'README.md', 'LICENSE', 'LICENCE'])

// `MANIFEST_PATH` is derived from import.meta.url — never from the process
// working directory — so the assertions target this repository's manifest even
// when the host validates inside a detached worktree or from another cwd.
// Neither the read nor the parse is guarded and no fallback value is
// substituted: a missing or unparsable manifest must fail the lane loudly
// instead of being swallowed.
const MANIFEST = requireObject(
  JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
  `root package.json at ${MANIFEST_PATH}`,
)

function typeLabel(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Render an actual value together with its type label for failure messages. */
function show(value) {
  if (typeof value === 'undefined') return 'undefined'
  const json = JSON.stringify(value)
  return json === undefined ? `${typeLabel(value)} <unserializable>` : `${typeLabel(value)} ${json}`
}

function requireObject(value, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be a JSON object, received ${show(value)}`,
  )
  return value
}

/** `./lib/index.js` -> `lib/index.js`, the form npm glob patterns match against. */
function fileName(target) {
  return target.startsWith('./') ? target.slice('./'.length) : target
}

/** Resolve a manifest-relative target against the repository root. */
function absoluteOf(target) {
  return join(ROOT, ...fileName(target).split('/'))
}

function isFile(absolutePath) {
  const stats = statSync(absolutePath, { throwIfNoEntry: false })
  return stats !== undefined && stats.isFile()
}

/** `main` after proving it is a string, so path helpers never see garbage. */
function declaredMainTarget() {
  const main = MANIFEST.main
  assert.equal(
    typeof main,
    'string',
    `package main must be a string path before it can be resolved on disk, received ${show(main)}`,
  )
  return main
}

/**
 * The live `exports` field as entries, after proving the field is an object and
 * that every target is a string.
 *
 * The type verdict is owned here rather than by the path helpers: routing a
 * non-string target into `absoluteOf` would replace the diagnostic below with a
 * message-less `TypeError`, and silently dropping it would let a broken export
 * shape pass the on-disk lane.
 */
function exportTargetEntries() {
  const exportsField = requireObject(MANIFEST.exports, `package exports in ${MANIFEST_PATH}`)
  return Object.entries(exportsField).map(([key, target]) => {
    assert.equal(
      typeof target,
      'string',
      `package exports[${JSON.stringify(key)}] must be a string target before it can be resolved on disk, received ${show(target)}`,
    )
    return [key, target]
  })
}

/** `main` plus every export target, deduplicated, in a stable order. */
function entryPointTargets() {
  return [...new Set([declaredMainTarget(), ...exportTargetEntries().map(([, target]) => target)])]
}

function requireEntryPointFile(target, context) {
  const absolute = absoluteOf(target)
  assert.equal(
    existsSync(absolute),
    true,
    `${context} target ${JSON.stringify(target)} must exist on disk at ${absolute}, existsSync returned ${show(existsSync(absolute))}`,
  )
  assert.equal(
    isFile(absolute),
    true,
    `${context} target ${JSON.stringify(target)} must be a regular file at ${absolute}, received ${show(isFile(absolute))}`,
  )
}

/**
 * Resolver mirroring `clientExportOf` in
 * `@deepseek-ai/dsh-client-modules/lib/index.js` (cited, never imported):
 * a string target is returned verbatim, an object target is accepted only when
 * its `default` member is a string, a missing `./client` key resolves to
 * `undefined`, and every other shape throws — the loader throws there too.
 */
function resolveClientExport(packageName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = client.default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(
    `client-modules: ${packageName} exports["./client"] must be a string or an object with a string default`,
  )
}

test('public test scripts explicitly build ignored package entry points before loading their suites', () => {
  const scripts = requireObject(MANIFEST.scripts, 'package scripts declaration')
  for (const name of ['build', 'test', 'test:unit']) {
    assert.equal(
      typeof scripts[name],
      'string',
      `package scripts[${JSON.stringify(name)}] must be a string, received ${show(scripts[name])}`,
    )
  }
  for (const name of ['test', 'test:unit']) {
    assert.equal(
      scripts[name].startsWith(`${scripts.build} && `),
      true,
      `package ${name} must explicitly run the build script body before its test loader, received ${show(scripts[name])} with build ${show(scripts.build)}`,
    )
  }
})

test('root package.json main and the four enumerated export keys map to their documented targets', () => {
  assert.equal(
    MANIFEST.main,
    MAIN_TARGET,
    `package main must be ${JSON.stringify(MAIN_TARGET)}, received ${show(MANIFEST.main)}`,
  )

  const exportsField = requireObject(MANIFEST.exports, `package exports in ${MANIFEST_PATH}`)
  for (const [key, target] of DOCUMENTED_EXPORTS) {
    assert.equal(
      Object.hasOwn(exportsField, key),
      true,
      `package exports must declare the ${JSON.stringify(key)} key, received keys ${JSON.stringify(Object.keys(exportsField))}`,
    )
    assert.equal(
      exportsField[key],
      target,
      `package exports[${JSON.stringify(key)}] must be ${JSON.stringify(target)}, received ${show(exportsField[key])}`,
    )
  }
})

test('every present exports key carries a safe relative target with no traversal or backslashes', () => {
  // No key set beyond the four documented keys is pinned here: whatever else the
  // manifest exports must still be a safe, package-relative file reference.
  for (const [key, target] of exportTargetEntries()) {
    const name = JSON.stringify(key)
    assert.ok(
      target.startsWith('./'),
      `package exports[${name}] must be a "./"-relative target inside the package, received ${show(target)}`,
    )
    assert.equal(
      target.includes('\\'),
      false,
      `package exports[${name}] must use forward slashes only, received ${show(target)}`,
    )
    assert.equal(
      target.split('/').includes('..'),
      false,
      `package exports[${name}] must not traverse with "..", received ${show(target)}`,
    )
    assert.ok(
      target.length > './'.length,
      `package exports[${name}] must name a file rather than a directory, received ${show(target)}`,
    )
  }
})

test('main and every export target exist on disk as regular files, including the lib build output', () => {
  // Declared for diagnostics only: the per-target messages below carry the
  // resolved absolute path, and the type verdict for each target is taken
  // before any path is built.
  assert.equal(
    MANIFEST.main,
    MAIN_TARGET,
    `package main must be ${JSON.stringify(MAIN_TARGET)}, received ${show(MANIFEST.main)}`,
  )
  requireEntryPointFile(declaredMainTarget(), 'main')

  for (const [key, target] of exportTargetEntries()) {
    requireEntryPointFile(target, `exports[${JSON.stringify(key)}]`)
  }
})

test('exports["./client"] resolves to the built client bundle through both loader-accepted shapes', () => {
  const fromString = resolveClientExport('string-form-fixture', { './client': CLIENT_TARGET })
  assert.equal(
    fromString,
    CLIENT_TARGET,
    `the plain string form must resolve verbatim, received ${show(fromString)}`,
  )

  const fromDefault = resolveClientExport('default-form-fixture', { './client': { default: CLIENT_TARGET } })
  assert.equal(
    fromDefault,
    CLIENT_TARGET,
    `the object-with-default form must resolve to its default member, received ${show(fromDefault)}`,
  )

  const fromConditionalDefault = resolveClientExport('conditional-form-fixture', {
    './client': { browser: './lib/other.js', default: CLIENT_TARGET },
  })
  assert.equal(
    fromConditionalDefault,
    CLIENT_TARGET,
    `only the default member may be consulted, received ${show(fromConditionalDefault)}`,
  )

  const missing = resolveClientExport('missing-fixture', { './index': MAIN_TARGET })
  assert.equal(
    missing,
    undefined,
    `a manifest without a ./client key must resolve to undefined, received ${show(missing)}`,
  )
  const explicitUndefined = resolveClientExport('undefined-fixture', { './client': undefined })
  assert.equal(
    explicitUndefined,
    undefined,
    `an undefined ./client key must resolve to undefined, received ${show(explicitUndefined)}`,
  )

  const rejectedShapes = [
    ['a number', 42],
    ['null', null],
    ['a default-less object', {}],
    ['an array', [CLIENT_TARGET]],
    ['an object whose default is not a string', { default: 42 }],
  ]
  for (const [label, value] of rejectedShapes) {
    assert.throws(
      () => resolveClientExport(label, { './client': value }),
      /must be a string or an object with a string default/,
      `the client loader rejects ${label} as exports["./client"], received ${show(value)}`,
    )
  }
})

test('the web client contract agrees across exports["./client"], dsh.client.platform and the shipped bundle', () => {
  const exportsField = requireObject(MANIFEST.exports, 'package exports')
  const liveTarget = exportsField['./client']
  assert.equal(
    typeof liveTarget,
    'string',
    `this manifest must use the plain string form of exports["./client"], received ${show(liveTarget)}`,
  )
  assert.equal(
    liveTarget,
    CLIENT_TARGET,
    `exports["./client"] must be ${JSON.stringify(CLIENT_TARGET)}, received ${show(liveTarget)}`,
  )

  const resolved = resolveClientExport(MANIFEST.name, exportsField)
  assert.equal(
    resolved,
    CLIENT_TARGET,
    `exports["./client"] must resolve to the built web client bundle for ${show(MANIFEST.name)}, received ${show(resolved)}`,
  )

  const dsh = requireObject(MANIFEST.dsh, 'package dsh declaration')
  assert.equal(
    Object.hasOwn(dsh, 'client'),
    true,
    `dsh must declare its client half as an own property, received keys ${JSON.stringify(Object.keys(dsh))}`,
  )
  const client = requireObject(dsh.client, 'dsh.client declaration')
  assert.equal(
    Object.hasOwn(client, 'platform'),
    true,
    `dsh.client must declare platform as an own property, received keys ${JSON.stringify(Object.keys(client))}`,
  )
  assert.equal(
    typeof client.platform,
    'string',
    `dsh.client.platform must be a string, received ${show(client.platform)}`,
  )
  assert.equal(
    client.platform,
    CLIENT_PLATFORM,
    `dsh.client.platform must be ${JSON.stringify(CLIENT_PLATFORM)} so the client module loader serves this bundle to the web client, received ${show(client.platform)}`,
  )

  // The loader joins the client target onto the package directory and serves it
  // as the web bundle, so the declared target has to be a real file.
  requireEntryPointFile(liveTarget, 'exports["./client"]')
})

test('the files whitelist ships main and every export target, with package.json as the only always-included exemption', () => {
  const files = MANIFEST.files
  assert.equal(
    typeLabel(files),
    'array',
    `package files must be an array of whitelist patterns, received ${show(files)}`,
  )
  for (const [index, pattern] of files.entries()) {
    assert.equal(
      typeof pattern,
      'string',
      `package files[${index}] must be a string pattern, received ${show(pattern)}`,
    )
    assert.ok(
      pattern.length > 0,
      `package files[${index}] must be a non-empty pattern, received ${show(pattern)}`,
    )
  }

  // Negative control: the whitelist matcher has to discriminate, otherwise a
  // vacuous "covered" verdict would hide a manifest that ships no build output.
  // `path.matchesGlob` is npm's own glob dialect for the `files` field, so no
  // custom matcher (and no extra dependency) is involved.
  assert.equal(
    matchesGlob('lib/index.js', 'lib/*.js'),
    true,
    `control: the files pattern "lib/*.js" must match "lib/index.js", received ${show(matchesGlob('lib/index.js', 'lib/*.js'))}`,
  )
  assert.equal(
    matchesGlob('lib/index.js', 'src/*.js'),
    false,
    `control: the files pattern "src/*.js" must not match "lib/index.js", received ${show(matchesGlob('lib/index.js', 'src/*.js'))}`,
  )

  const coverage = entryPointTargets().map(target => {
    const name = fileName(target)
    return { target, name, matchingPatterns: files.filter(pattern => matchesGlob(name, pattern)) }
  })

  // npm semantics: a target is published when a files pattern covers it, or when
  // it is one of the names npm always includes regardless of `files`. Only
  // `package.json` may use the second route in this manifest, and
  // `NPM_ALWAYS_INCLUDED` deliberately omits the main file name, so `main` still
  // has to earn a real pattern instead of riding an exemption.
  const exemptions = coverage
    .filter(entry => entry.matchingPatterns.length === 0)
    .map(entry => entry.name)
  const unpublished = exemptions.filter(name => !NPM_ALWAYS_INCLUDED.includes(name))
  assert.deepEqual(
    unpublished,
    [],
    `every entry point must be shipped either by a files pattern or by the npm always-included rule; unmatched entry points ${JSON.stringify(unpublished)} against files ${JSON.stringify(files)} and coverage ${JSON.stringify(coverage)}`,
  )

  // The exemption route must stay bounded to package.json here: an export target
  // that is not an always-included name may never pass uncovered.
  assert.deepEqual(
    exemptions.filter(name => name !== 'package.json'),
    [],
    `package.json is this manifest's only target allowed to rely on the npm always-included rule, received other exemptions ${JSON.stringify(exemptions.filter(name => name !== 'package.json'))} from coverage ${JSON.stringify(coverage)}`,
  )

  // package.json is the one target allowed to be covered by the always-included
  // rule rather than a pattern, so prove it is actually present in the set that
  // was checked instead of silently falling out of the lane.
  const packageEntry = coverage.find(entry => entry.target === './package.json')
  assert.notEqual(
    packageEntry,
    undefined,
    `the ./package.json export must participate in the files coverage check, received coverage ${JSON.stringify(coverage)} for targets ${JSON.stringify(entryPointTargets())}`,
  )
})

test('the dsh bundle patch declaration is pinned to the shipped overlay file', () => {
  const dsh = requireObject(MANIFEST.dsh, 'package dsh declaration')
  assert.equal(
    Object.hasOwn(dsh, 'bundle'),
    true,
    `dsh must declare its bundle half as an own property, received keys ${JSON.stringify(Object.keys(dsh))}`,
  )
  const bundle = requireObject(dsh.bundle, 'dsh.bundle declaration')
  assert.equal(
    Object.hasOwn(bundle, 'patch'),
    true,
    `dsh.bundle must declare patch as an own property, received keys ${JSON.stringify(Object.keys(bundle))}`,
  )
  assert.equal(
    typeof bundle.patch,
    'string',
    `dsh.bundle.patch must be a string that names the shipped patch file, received ${show(bundle.patch)}`,
  )
  assert.ok(
    bundle.patch.length > 0,
    `dsh.bundle.patch must be a non-empty relative path, received ${show(bundle.patch)}`,
  )
  assert.equal(
    bundle.patch,
    PATCH_TARGET,
    `dsh.bundle.patch must be ${JSON.stringify(PATCH_TARGET)}, received ${show(bundle.patch)}`,
  )

  const exportsField = requireObject(MANIFEST.exports, 'package exports')
  assert.equal(
    bundle.patch,
    exportsField['./cordis.patch.yml'],
    `dsh.bundle.patch must equal the ./cordis.patch.yml export target, received ${show(bundle.patch)} against export ${show(exportsField['./cordis.patch.yml'])}`,
  )

  // The boot layer joins the declared value onto the package directory.
  requireEntryPointFile(bundle.patch, 'dsh.bundle.patch')
})

test('the dsh client declaration carries a web platform and a string inject list', () => {
  const dsh = requireObject(MANIFEST.dsh, 'package dsh declaration')
  assert.equal(
    Object.hasOwn(dsh, 'client'),
    true,
    `dsh must declare its client half as an own property, received keys ${JSON.stringify(Object.keys(dsh))}`,
  )
  const client = requireObject(dsh.client, 'dsh.client declaration')
  assert.equal(
    Object.hasOwn(client, 'platform'),
    true,
    `dsh.client must declare platform as an own property, received keys ${JSON.stringify(Object.keys(client))}`,
  )
  assert.equal(
    typeof client.platform,
    'string',
    `dsh.client.platform must be a string, received ${show(client.platform)}`,
  )
  assert.equal(
    client.platform,
    CLIENT_PLATFORM,
    `dsh.client.platform must be ${JSON.stringify(CLIENT_PLATFORM)}, received ${show(client.platform)}`,
  )

  assert.equal(
    Object.hasOwn(client, 'inject'),
    true,
    `dsh.client must declare inject as an own property, received keys ${JSON.stringify(Object.keys(client))}`,
  )
  const inject = client.inject
  assert.equal(
    typeLabel(inject),
    'array',
    `dsh.client.inject must be an array of module specifiers, received ${show(inject)}`,
  )
  for (const [index, specifier] of inject.entries()) {
    assert.equal(
      typeof specifier,
      'string',
      `dsh.client.inject[${index}] must be a string specifier, received ${show(specifier)}`,
    )
    assert.ok(
      specifier.length > 0,
      `dsh.client.inject[${index}] must be a non-empty specifier, received ${show(specifier)}`,
    )
  }
})
