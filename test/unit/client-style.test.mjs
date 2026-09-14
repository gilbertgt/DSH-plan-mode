import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { STYLE } from '../../src/client/styles.ts'

const MANIFEST = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const INDEX_SOURCE = readFileSync(new URL('../../src/client/index.tsx', import.meta.url), 'utf8')

/**
 * Split a stylesheet into flat `{ selector, declarations }` records.
 *
 * The pattern only matches innermost blocks, so a rule nested in
 * `@media (...)` is returned with the media condition dropped. That is exactly
 * what these assertions need: a conditional rule is still a rule, and a
 * `<select>` painted transparent inside a dark-theme media query is as
 * unreadable as an unconditional one.
 */
function rules(css) {
  const found = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.push({ selector: match[1].trim(), declarations: declarations(match[2]) })
  }
  return found
}

function declarations(body) {
  const map = new Map()
  for (const entry of body.split(';')) {
    const at = entry.indexOf(':')
    if (at === -1) continue
    map.set(entry.slice(0, at).trim(), entry.slice(at + 1).trim())
  }
  return map
}

/** Selector list entries that target a bare element of `name`. */
function partsFor(selector, name) {
  const pattern = new RegExp(`(^|[\\s>+~])${name}\\b(?![\\w-])`)
  return selector.split(',').map(part => part.trim()).filter(part => pattern.test(part))
}

const RULES = rules(STYLE)

/** Every rule that styles a `<select>` through at least one of its selectors. */
const SELECT_RULES = RULES.filter(rule => partsFor(rule.selector, 'select').length > 0)

/** Every rule that styles a plain `<input>` (the checkbox rule excluded). */
const INPUT_RULES = RULES.filter(rule => partsFor(rule.selector, 'input').some(part => !part.includes('[type=')))

test('the stylesheet parses and actually styles selects', () => {
  assert.ok(RULES.length > 5, 'the rule parser must find the stylesheet rules')
  assert.ok(SELECT_RULES.length > 0, 'the stylesheet must style .planx select')
})

test('no select rule paints its background transparent', () => {
  // `background:transparent` on the popup entries lets the page show through
  // the native dropdown, which is what made the unhighlighted options
  // unreadable; on the control it is equally invisible in a composed theme.
  const offenders = []
  for (const rule of SELECT_RULES) {
    for (const [property, value] of rule.declarations) {
      if (property !== 'background' && property !== 'background-color') continue
      if (/\btransparent\b/.test(value)) offenders.push(`${rule.selector} { ${property}: ${value} }`)
    }
  }
  assert.deepEqual(offenders, [], 'select rules must not use a transparent background')
})

test('the select control carries an opaque theme background and foreground', () => {
  const control = RULES.find(rule => rule.selector === '.planx select')
  assert.ok(control, '.planx select must have its own rule')
  assert.equal(
    control.declarations.get('background'),
    'var(--dsw-alias-bg-layer-1,Canvas)',
    'the select must resolve an opaque background from the DSH theme token',
  )
  assert.equal(
    control.declarations.get('color'),
    'var(--dsw-alias-label-primary,CanvasText)',
    'the select must resolve its ink from the DSH theme token',
  )
  // The geometry of the pre-existing shared rule must survive the split,
  // otherwise the fix shifts the layout of the settings panel.
  assert.equal(control.declarations.get('border'), '1px solid color-mix(in srgb,currentColor 20%,transparent)')
  assert.equal(control.declarations.get('border-radius'), '7px')
  assert.equal(control.declarations.get('padding'), '7px')
  assert.equal(control.declarations.get('min-width'), '0')
})

test('the select option entries inherit an opaque background and color', () => {
  const option = RULES.find(rule => rule.selector === '.planx select option')
  assert.ok(option, '.planx select option must have its own rule')
  assert.equal(option.declarations.get('background'), 'inherit', 'options must inherit the opaque control background')
  assert.equal(option.declarations.get('color'), 'inherit', 'options must inherit the readable control foreground')
})

test('inputs keep their transparent background and checkbox styling', () => {
  // The shared `input,select` rule was split so `select` could stop being
  // transparent. `input` must not have been dragged along with that change.
  assert.ok(INPUT_RULES.length > 0, 'the generic .planx input rule must remain')
  for (const rule of INPUT_RULES) {
    assert.equal(rule.declarations.get('background'), 'transparent', `${rule.selector} must stay transparent`)
    assert.equal(rule.declarations.get('color'), 'inherit')
    assert.equal(rule.declarations.get('border'), '1px solid color-mix(in srgb,currentColor 20%,transparent)')
    assert.equal(rule.declarations.get('border-radius'), '7px')
    assert.equal(rule.declarations.get('padding'), '7px')
    assert.equal(rule.declarations.get('min-width'), '0')
  }
  assert.equal(
    RULES.some(rule => partsFor(rule.selector, 'input').length > 0 && partsFor(rule.selector, 'select').length > 0),
    false,
    'input and select must not share one rule: that is what forced select to be transparent',
  )
  assert.ok(
    RULES.some(rule => rule.selector === '.planx input[type="checkbox"]' && rule.declarations.get('width') === 'auto'),
    'the checkbox width rule must remain untouched',
  )
})

test('the injected style tag is owned by the full package name', () => {
  // The client HMR receiver removes every `style[data-plugin]` whose attribute
  // equals the plugin id verbatim. A short id never matches, so a reload left
  // the previous stylesheet in the document and a fix appeared to do nothing.
  const match = INDEX_SOURCE.match(/style\.dataset\.plugin\s*=\s*(['"])([^'"]+)\1/)
  assert.ok(match, 'index.tsx must assign style.dataset.plugin a literal plugin id')
  assert.equal(match[2], MANIFEST.name, 'the style tag must be tagged with the full package name')
  assert.notEqual(match[2], 'dsh-plan-orchestrator', 'the bare short id must not come back')
})
