import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/**
 * The four stages the pipeline must always run in order: approval, the Worker
 * edit, host validation, and the Reviewer verdict.
 *
 * This used to compare a locally declared string array against itself, which
 * could not fail for any change to the plugin. It now reads the production
 * sources: each stage must exist, the engine must reach them in order, and the
 * report must be delivered from the single terminal point rather than from a
 * COMPLETE-only branch.
 */
test('the production pipeline declares all four stages in order', () => {
  const engine = read('src/orchestration/engine.ts')
  const positions = ['WORKERS', 'VALIDATING', 'REVIEWING', 'COMPLETE'].map(stage => {
    const index = engine.indexOf(`phase: '${stage}'`)
    assert.notEqual(index, -1, `the engine must emit the ${stage} phase`)
    return index
  })
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'the engine must emit WORKERS, VALIDATING, REVIEWING and COMPLETE in that order',
  )
})

test('the approval handoff is installed from the plan-mode exit tool', () => {
  const bridge = read('src/planning/native-plan-bridge.ts')
  assert.match(bridge, /exit_plan_mode/, 'the approval handoff must bind to the native exit tool')
  const index = read('src/index.ts')
  assert.match(index, /consumeApprovedPlanResult/, 'the approved plan must be consumed into orchestration')
})

test('host validation runs the planned package script in an isolated lease', () => {
  const engine = read('src/orchestration/engine.ts')
  assert.match(engine, /validateIsolated/, 'the engine must validate through the isolated path')
  const runner = read('src/validation/runner.ts')
  assert.match(runner, /resolveValidationExecutable|parseValidationCommand/, 'validation must resolve a package script')
  assert.match(runner, /assertExistingPackageScript/, 'validation must refuse a missing package script')
})

test('the Reviewer verdict is parsed and gates COMPLETE', () => {
  const engine = read('src/orchestration/engine.ts')
  assert.match(engine, /parseReviewVerdict/, 'the engine must parse the Reviewer verdict')
  assert.match(engine, /REVIEW_CONTRACT/, 'the Reviewer must receive the review contract')
  const reviewer = read('src/orchestration/reviewer.ts')
  assert.match(reviewer, /REVIEW:\(PASS\|FAIL\)/, 'the verdict protocol must be the marker protocol')
})

test('the terminal report is delivered from the single terminal point, for every outcome', () => {
  const service = read('src/orchestration/service.ts')
  assert.match(service, /deliverReport/, 'finalize must deliver the terminal report')
  assert.match(service, /#reported/, 'delivery must be deduplicated per run')
  const engine = read('src/orchestration/engine.ts')
  assert.doesNotMatch(engine, /agent\.inject\(/, 'the engine must not keep its own wake-less inject')
  assert.doesNotMatch(engine, /createUserMessage/, 'the engine must not compose its own terminal message')
})
