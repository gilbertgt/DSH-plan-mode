import test from 'node:test'
import assert from 'node:assert/strict'
import { sdkLaneUnavailable } from '../../src/orchestration/sdk-backend.ts'
import { settleSdkWave } from '../../src/orchestration/engine.ts'

/**
 * The SDK lane is an isolation strategy, not a requirement. When it is
 * unusable the run downgrades to serial rather than failing, so this classifier
 * decides whether a whole plan survives. It must accept environment faults and
 * reject task faults.
 */
test('an unusable SDK profile is classified as a lane failure', () => {
  // The verbatim shape that failed run f8ee7874 and killed a whole plan.
  const observed = new Error(
    'dsh profile "sdk": JSON-RPC input closed\n'
    + "exit code: 1\nstderr tail:\n  code: 'ERR_MODULE_NOT_FOUND'\n"
    + "Error: failed to import loader entry fs-observation-policy (@deepseek-ai/dsh-fs-observation-policy): "
    + "Cannot find package '@deepseek-ai/dsh-fs' imported from C:\\Users\\u\\.dsh\\profiles\\web\\node_modules\\x\\lib\\index.js",
  )
  assert.equal(sdkLaneUnavailable(observed), true)
})

test('each documented environment fault shape is classified as a lane failure', () => {
  const cases = [
    { code: 'ERR_MODULE_NOT_FOUND', message: 'Cannot find module' },
    { message: 'Cannot find package "@deepseek-ai/dsh-fs"' },
    { message: 'dsh profile "sdk": JSON-RPC input closed' },
    { message: 'failed to import loader entry fs-observation-policy' },
    { message: 'dsh profile "sdk" not found' },
    { message: 'dsh profile "sdk" unavailable' },
    { message: 'ERR_MODULE_NOT_FOUND' },
  ]
  for (const shape of cases) {
    const error = shape.code === undefined
      ? new Error(shape.message)
      : Object.assign(new Error(shape.message), { code: shape.code })
    assert.equal(sdkLaneUnavailable(error), true, `${JSON.stringify(shape)} must classify as an unusable lane`)
  }
})

test('task faults are never excused as a lane failure', () => {
  // These must fail the run: they mean the work itself is wrong, and silently
  // downgrading them would hide ownership escapes and unsatisfied contracts.
  const cases = [
    new Error('worker t1: BLOCKED'),
    new Error('worker t1: FAILED'),
    new Error('subagent t1 finished without returning the required structured completion contract'),
    new Error('ownership violation: outside.ts is not owned by t1'),
    new Error('HEAD drift before parallel wave'),
    new Error('worker stage incomplete: 0/1'),
    new Error('patch artifact hash mismatch for t1'),
    new Error('approval baseline HEAD drift: aaa -> bbb'),
    new Error('reviewer protocol invalid after retry'),
    new Error('validation failed: npm run test:unit failed'),
    new Error('task says Cannot find package user-domain-model'),
    new Error('provider JSON-RPC input closed during a task response'),
    Object.assign(new Error('operation cancelled'), { code: 'ABORT_ERR' }),
  ]
  for (const error of cases) {
    assert.equal(sdkLaneUnavailable(error), false, `${error.message} must not be excused as a lane failure`)
  }
})

test('a plain string and a non-Error value are classified without throwing', () => {
  assert.equal(sdkLaneUnavailable('Cannot find package "@deepseek-ai/dsh-fs"'), true)
  assert.equal(sdkLaneUnavailable('worker t1: BLOCKED'), false)
  assert.equal(sdkLaneUnavailable(undefined), false)
  assert.equal(sdkLaneUnavailable(null), false)
  assert.equal(sdkLaneUnavailable({}), false)
})

test('SDK wave fallback waits for every sibling worker to settle', async () => {
  let release
  const slow = new Promise(resolve => { release = resolve })
  const unavailable = Promise.reject(new Error('dsh profile "sdk": JSON-RPC input closed'))
  const wave = settleSdkWave([unavailable, slow])
  let finished = false
  void wave.then(() => { finished = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(finished, false, 'fallback must not start while a sibling SDK worker is still running')
  release('sibling-complete')
  const result = await wave
  assert.equal(result.kind, 'unavailable')
})

test('a task failure wins over an SDK environment failure after the wave drains', async () => {
  const taskFailure = new Error('ownership violation: outside.ts is not owned by t1')
  await assert.rejects(
    () => settleSdkWave([
      Promise.reject(new Error('dsh profile "sdk": JSON-RPC input closed')),
      Promise.reject(taskFailure),
    ]),
    error => error === taskFailure,
  )
})

test('a successful SDK wave preserves outcome order', async () => {
  const result = await settleSdkWave([Promise.resolve('a'), Promise.resolve('b')])
  assert.deepEqual(result, { kind: 'complete', outcomes: ['a', 'b'] })
})
