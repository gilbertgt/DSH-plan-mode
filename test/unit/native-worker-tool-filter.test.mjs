import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveOwnershipSafeToolAllow } from '../../src/orchestration/native-backend.ts'

function ctxWithTools(names) {
  return {
    tools: {
      schemas: () => names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
    },
  }
}

test('native worker tool filter intersects the safe policy with the active DSH global catalog', () => {
  const ctx = ctxWithTools([
    'ask_user_question',
    'read',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'write',
    'edit',
    'git_commit',
    'pwsh',
  ])

  assert.deepEqual(resolveOwnershipSafeToolAllow(ctx), [
    'read',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'write',
    'edit',
  ])
})

test('native worker tool filter keeps registered safe aliases without inventing absent aliases', () => {
  const ctx = ctxWithTools(['read', 'write_file', 'apply_patch', 'run_code'])
  assert.deepEqual(resolveOwnershipSafeToolAllow(ctx), ['read', 'write_file', 'apply_patch'])
})

test('native worker tool filter fails closed when the authoritative catalog API is unavailable', () => {
  assert.throws(
    () => resolveOwnershipSafeToolAllow({ tools: {} }),
    /tools\.schemas unavailable for ownership-safe tool filtering/,
  )
})

test('native worker tool filter fails closed when the catalog contains no ownership-safe tools', () => {
  const ctx = ctxWithTools(['pwsh', 'git_commit', 'run_code'])
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx),
    /no ownership-safe global tools are registered in the active DSH profile/,
  )
})

test('native worker tool filter contains catalog failures instead of broadening access', () => {
  const ctx = { tools: { schemas: () => { throw new Error('catalog offline') } } }
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx),
    /tools\.schemas failed for ownership-safe tool filtering: catalog offline/,
  )
})
