import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TOKENS_CEILING,
  effortState,
  isCustomMaxTokens,
  normalizeCapability,
  phaseLabel,
  setMaxTokens,
  setModel,
  setProvider,
  setReasoningEffort,
} from '../../src/client/role-route-ui.ts'
import { validateSettings, DEFAULT_SETTINGS } from '../../src/contract/settings.ts'

const fixed = (extra = {}) => ({ mode: 'fixed', provider: 'prov', model: 'mod', fallbacks: [], ...extra })

/** Walk every own property and fail on a value that is literally `undefined`. */
function assertNoUndefinedProperties(value, path = 'route') {
  if (value === undefined) throw new Error(`${path} is undefined; the property must be omitted instead`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefinedProperties(item, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} must not be an explicit undefined`)
    assertNoUndefinedProperties(item, `${path}.${key}`)
  }
}

test('routine transitions never leave an explicit undefined property behind', () => {
  const start = fixed({ reasoningEffort: 'high', maxTokens: 4096 })
  // Every one of these clears at least one optional control.
  const results = [
    setProvider(start, 'other'),
    setModel(start, 'other-model'),
    setReasoningEffort(start, undefined),
    setMaxTokens(start, undefined),
    setMaxTokens(start, 0),
    setMaxTokens(start, Number.NaN),
    setMaxTokens(start, 1.5),
    setMaxTokens(setReasoningEffort(setModel(start, 'm2'), undefined), undefined),
  ]
  for (const [index, route] of results.entries()) assertNoUndefinedProperties(route, `results[${index}]`)
})

test('switching provider drops the model and every model-specific control', () => {
  const route = fixed({ reasoningEffort: 'high', maxTokens: 4096 })
  const next = setProvider(route, 'provider-b')
  assert.equal(next.provider, 'provider-b')
  assert.equal(Object.hasOwn(next, 'model'), false, 'model belonged to the previous provider')
  assert.equal(Object.hasOwn(next, 'reasoningEffort'), false, 'effort must not survive a provider switch')
  assert.equal(Object.hasOwn(next, 'maxTokens'), false, 'maxTokens must not survive a provider switch')
})

test('switching model keeps the provider but drops effort and maxTokens', () => {
  const route = fixed({ reasoningEffort: 'high', maxTokens: 4096 })
  const next = setModel(route, 'model-b')
  assert.equal(next.provider, 'prov')
  assert.equal(next.model, 'model-b')
  assert.equal(Object.hasOwn(next, 'reasoningEffort'), false, 'effort is a capability of the exact model')
  assert.equal(Object.hasOwn(next, 'maxTokens'), false, 'maxTokens is a capability of the exact model')
})

test('Auto removes reasoningEffort and Custom persists it', () => {
  const auto = setReasoningEffort(fixed({ reasoningEffort: 'high' }), undefined)
  assert.equal(Object.hasOwn(auto, 'reasoningEffort'), false)
  const custom = setReasoningEffort(fixed(), 'low')
  assert.equal(custom.reasoningEffort, 'low')
})

test('Auto removes maxTokens, Custom persists a valid integer, invalid input omits it', () => {
  const auto = setMaxTokens(fixed({ maxTokens: 1234 }), undefined)
  assert.equal(Object.hasOwn(auto, 'maxTokens'), false, 'Auto is property omission')
  assert.equal(setMaxTokens(fixed(), 2048).maxTokens, 2048)
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TOKENS_CEILING + 1]) {
    const route = setMaxTokens(fixed(), invalid)
    assert.equal(Object.hasOwn(route, 'maxTokens'), false, `${invalid} must not be stored`)
  }
})

test('isCustomMaxTokens distinguishes stored numbers from Auto', () => {
  assert.equal(isCustomMaxTokens(fixed({ maxTokens: 10 })), true)
  assert.equal(isCustomMaxTokens(fixed()), false)
  assert.equal(isCustomMaxTokens(fixed({ maxTokens: 1.5 })), false)
  assert.equal(isCustomMaxTokens(fixed({ maxTokens: 0 })), false)
})

test('transitions still satisfy the authoritative settings validator', () => {
  // The default routes are `mode: 'current'`, which the contract forbids from
  // carrying fixed-route fields at all; switching to Fixed is the UI's job
  // before any provider/model control becomes editable.
  const base = structuredClone(DEFAULT_SETTINGS)
  base.roles.worker = { ...base.roles.worker, mode: 'fixed' }
  base.roles.worker = setMaxTokens(setReasoningEffort(setModel(setProvider(base.roles.worker, 'prov'), 'mod'), 'high'), 4096)
  assert.equal(base.roles.worker.reasoningEffort, 'high')
  assert.equal(base.roles.worker.maxTokens, 4096)
  const checked = validateSettings(base)
  assert.equal(checked.roles.worker.mode, 'fixed')
  assert.equal(checked.roles.worker.provider, 'prov')
  assert.equal(checked.roles.worker.maxTokens, 4096)
  assert.equal(Object.hasOwn(checked.roles.worker, 'reasoningEffort'), true)

  // The Auto form must round-trip without inventing an optional property.
  const auto = structuredClone(DEFAULT_SETTINGS)
  auto.roles.planner = { ...auto.roles.planner, mode: 'fixed' }
  auto.roles.planner = setMaxTokens(setReasoningEffort(setModel(setProvider(auto.roles.planner, 'p'), 'm'), undefined), undefined)
  const autoChecked = validateSettings(auto)
  assert.equal(Object.hasOwn(autoChecked.roles.planner, 'reasoningEffort'), false)
  assert.equal(Object.hasOwn(autoChecked.roles.planner, 'maxTokens'), false)

  // Auto maxTokens alone must also survive the validator untouched.
  const custom = structuredClone(DEFAULT_SETTINGS)
  custom.roles.reviewer = { ...custom.roles.reviewer, mode: 'fixed' }
  custom.roles.reviewer = setMaxTokens(setModel(setProvider(custom.roles.reviewer, 'p'), 'm'), 777)
  const customChecked = validateSettings(custom)
  assert.equal(customChecked.roles.reviewer.maxTokens, 777)
  assert.equal(Object.hasOwn(customChecked.roles.reviewer, 'reasoningEffort'), false)
})

test('normalizeCapability reads only declared adapter evidence', () => {
  const full = normalizeCapability({
    provider: 'p', model: 'm',
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'more' }], defaultEffort: 'high' },
    defaultMaxTokens: 8192,
    contextWindow: 128000,
  })
  assert.deepEqual(full.efforts.map(e => e.id), ['low', 'high'])
  assert.equal(full.efforts[1].description, 'more')
  assert.equal(full.defaultEffort, 'high')
  assert.equal(full.defaultMaxTokens, 8192)
  assert.equal(full.contextWindow, 128000)
  // The normalized shape must never expose a field named maxTokens: rc.1 has no
  // authoritative per-model ceiling, and a field with that name would read as one.
  assert.equal(Object.hasOwn(full, 'maxTokens'), false)
})

test('a model without reasoning metadata yields no fabricated options', () => {
  const none = normalizeCapability({ provider: 'p', model: 'm', defaultMaxTokens: 4096 })
  assert.deepEqual(none.efforts, [])
  assert.equal(none.defaultEffort, undefined)
  assert.equal(Object.hasOwn(none, 'maxTokens'), false)
  assert.equal(none.defaultMaxTokens, 4096, 'the per-request default is still reported, as information')
})

test('malformed or unavailable payloads collapse to no capability', () => {
  assert.deepEqual(normalizeCapability(undefined).efforts, [])
  assert.deepEqual(normalizeCapability(null).efforts, [])
  assert.deepEqual(normalizeCapability('nope').efforts, [])
  assert.deepEqual(normalizeCapability([]).efforts, [])
  assert.deepEqual(normalizeCapability({ reasoning: { efforts: 'bad' } }).efforts, [])
  // Entries missing an id or a name are dropped rather than rendered blank.
  assert.deepEqual(normalizeCapability({ reasoning: { efforts: [{ id: 'x' }, { name: 'y' }, { id: 'z', name: 'Z' }] } }).efforts.map(e => e.id), ['z'])
  // Duplicates are ignored.
  assert.deepEqual(normalizeCapability({ reasoning: { efforts: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }] } }).efforts.map(e => e.name), ['A'])
  const down = normalizeCapability({ provider: 'p', model: 'm', unavailable: 'adapter refused' })
  assert.equal(down.unavailable, 'adapter refused')
  assert.deepEqual(down.efforts, [])
})

test('defaultEffort is only surfaced when the adapter also offers that effort', () => {
  const stray = normalizeCapability({ reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'high' } })
  assert.equal(stray.defaultEffort, undefined, 'an unoffered default must not be shown as selectable')
})

test('effortState preserves a stored value the model does not report', () => {
  const capability = normalizeCapability({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })
  const legacy = effortState(fixed({ reasoningEffort: 'custom-legacy' }), capability)
  assert.equal(legacy.value, 'custom-legacy', 'the stored value must be shown verbatim')
  assert.equal(legacy.legacy, true, 'the UI must be told to warn')
  assert.equal(legacy.disabled, false, 'the user must still be able to switch back to Auto')

  const known = effortState(fixed({ reasoningEffort: 'low' }), capability)
  assert.equal(known.legacy, false)
  assert.equal(known.disabled, false)

  // Nothing offered and nothing stored: Auto is the only choice.
  const empty = effortState(fixed(), normalizeCapability({}))
  assert.equal(empty.disabled, true)
  assert.equal(empty.value, '')
})

test('phaseLabel localizes known phases and never guesses at unknown ones', () => {
  const t = key => `[${key}]`
  assert.equal(phaseLabel(t, 'WORKERS'), '[phase.WORKERS]')
  assert.equal(phaseLabel(t, 'CANCELLED'), '[phase.CANCELLED]')
  // A phase this build does not know stays readable instead of rendering a key.
  assert.equal(phaseLabel(t, 'SOMETHING_NEW'), 'SOMETHING_NEW')
  assert.equal(phaseLabel(t, undefined), '')
  assert.equal(phaseLabel(t, 42), '')
})
