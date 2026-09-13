import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zh, en } from '../../src/client/locales.ts'
import { RUN_PHASES } from '../../src/client/role-route-ui.ts'

const CLIENT_ROOT = resolve(import.meta.dirname, '../../src/client')

// `locales.ts` is the dictionary itself, so it is the one file allowed to hold
// every literal below.
const DICTIONARY_FILE = 'locales.ts'

function clientSources(dir = CLIENT_ROOT, found = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { clientSources(full, found); continue }
    if (/\.(tsx?|jsx?)$/.test(name) && name !== DICTIONARY_FILE) found.push(full)
  }
  return found
}

const SOURCES = clientSources().map(path => ({ path, text: readFileSync(path, 'utf8') }))
const relative = path => path.slice(CLIENT_ROOT.length + 1).replace(/\\/g, '/')

/**
 * Remove comments before scanning for copy or translate keys.
 *
 * Documentation legitimately names the literals under test (this module's own
 * header discusses the rejected `undefined` shape, and `role-route-ui.ts`
 * explains why a model switch drops the reasoning effort), so a raw text scan
 * would report the explanation as if it were the defect.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

const CODE = SOURCES.map(entry => ({ path: entry.path, code: stripComments(entry.text) }))

test('zh and en dictionaries carry identical non-empty key sets', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en must declare exactly the zh key set')
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string')
    assert.ok(zh[key].length > 0, `zh.${key} must not be empty`)
    assert.equal(typeof en[key], 'string')
    assert.ok(en[key].length > 0, `en.${key} must not be empty`)
  }
  assert.equal(new Set(zhKeys).size, zhKeys.length, 'zh must not declare duplicate keys')
})

test('every dynamic key family is fully covered by both dictionaries', () => {
  // These keys are built at runtime (`t('tabs.' + id)`, `t('roles.' + role)`,
  // `t('phase.' + phase)`), so a plain literal scan cannot see them.
  const dynamic = [
    ...['overview', 'roles', 'planning', 'execution', 'review', 'recovery', 'external', 'diagnostics'].map(key => `tabs.${key}`),
    ...['planner', 'worker', 'integrator', 'reviewer'].map(role => `roles.${role}`),
    ...RUN_PHASES.map(phase => `phase.${phase}`),
  ]
  for (const key of dynamic) {
    assert.ok(Object.hasOwn(zh, key), `zh is missing dynamic key ${key}`)
    assert.ok(Object.hasOwn(en, key), `en is missing dynamic key ${key}`)
  }
  assert.equal(RUN_PHASES.length, 15, 'the run-phase list must stay complete')
})

test('every literal t() key used by client code exists in both dictionaries', () => {
  const used = new Map()
  for (const { path, code } of CODE) {
    for (const match of code.matchAll(/\bt\??\.?\(?\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
      const key = match[1]
      // `t('roles.' + role)` is a dynamic-key prefix, not a key; the dynamic
      // families are asserted complete by the dedicated test above.
      if (key.endsWith('.')) continue
      if (!used.has(key)) used.set(key, [])
      used.get(key).push(relative(path))
    }
  }
  assert.ok(used.size > 0, 'the scan must find at least one literal key')
  const missing = []
  for (const [key, files] of used) {
    if (!Object.hasOwn(zh, key) || !Object.hasOwn(en, key)) missing.push(`${key} (${[...new Set(files)].join(', ')})`)
  }
  assert.deepEqual(missing, [], 'every literal t() key must exist in zh and en')
})

test('client surfaces carry no hard-coded English UI literals', () => {
  // Exact literals only, so identifiers, CSS classes, settings values and
  // RPC/technical strings are never mistaken for user-visible copy.
  const forbidden = [
    'Loading…', '>Save<', '>Stop<', 'Resume safely', 'Cleanup',
    'Current Session', '>Fixed<', 'Reasoning effort', 'Max Tokens', 'Select…',
    'Strict Planner read-only', 'Adaptive Research', 'Progressive discovery',
    'Trusted host validation is mandatory', 'No loaded runs.',
  ]
  const offenders = []
  for (const { path, code } of CODE) {
    for (const literal of forbidden) {
      if (code.includes(literal)) offenders.push(`${relative(path)}: ${literal}`)
    }
  }
  assert.deepEqual(offenders, [], 'user-visible English must come from the dictionary')
})

test('tab labels are dictionary keys rather than inline English', () => {
  const section = CODE.find(entry => relative(entry.path) === 'section.tsx')
  assert.ok(section, 'section.tsx must exist')
  // The old shape was a [id, 'English label'] tuple consumed as `t?.(id) ?? label`.
  assert.doesNotMatch(section.code, /t\?\.\([^)]*\)\s*\?\?/, 'no hard-coded translate fallback may remain')
  assert.match(section.code, /t\('tabs\.'\s*\+\s*id\)/, 'tab labels must be read from the dictionary')
})

test('the client never writes an explicit undefined optional control', () => {
  // `undefined` must be expressed by omitting the property: the lossless-JSON
  // boundaries these routes cross reject an explicitly undefined property, and
  // the settings contract rejects fixed-route fields on a non-fixed route.
  const offenders = []
  for (const { path, code } of CODE) {
    for (const [index, line] of code.split('\n').entries()) {
      if (/(?:reasoningEffort|maxTokens)\s*:\s*undefined/.test(line)) {
        offenders.push(`${relative(path)}:${index + 1}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'optional controls must be omitted, never written as undefined')
})
