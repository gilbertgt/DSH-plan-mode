import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveOwnershipSafeToolAllow } from '../../src/orchestration/native-backend.ts'

function schemasFor(names) {
  return names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
}

function ctxWithTools(globalNames, scopedNames = globalNames) {
  const parent = { id: 'parent' }
  return {
    parent,
    ctx: {
      tools: {
        schemas: agent => schemasFor(agent === parent ? scopedNames : globalNames),
      },
    },
  }
}

function tool(name) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => `ran:${name}`,
  }
}

async function realPresetScopedTools(names) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const parent = { id: 'parent' }
  let scope
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, parent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  for (const name of names) scope.ctx.tools.register(tool(name))
  return { ctx, parent, scope }
}

test('native worker tool filter resolves the parent capability view when the global DSH catalog is empty', async (t) => {
  const visible = [
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
  ]
  const { ctx, parent, scope } = await realPresetScopedTools(visible)
  t.after(async () => { await scope.dispose() })

  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), [])
  assert.deepEqual(ctx.tools.schemas(parent).map(schema => schema.name).sort(), [...visible].sort())
  assert.deepEqual(resolveOwnershipSafeToolAllow(ctx, parent), [
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
  const { ctx, parent } = ctxWithTools([], ['read', 'write_file', 'apply_patch', 'run_code'])
  assert.deepEqual(resolveOwnershipSafeToolAllow(ctx, parent), ['read', 'write_file', 'apply_patch'])
})

test('native worker tool filter fails closed when the authoritative catalog API is unavailable', () => {
  assert.throws(
    () => resolveOwnershipSafeToolAllow({ tools: {} }, { id: 'parent' }),
    /tools\.schemas unavailable for ownership-safe tool filtering/,
  )
})

test('native worker tool filter fails closed when the parent agent is unavailable', () => {
  const { ctx } = ctxWithTools([], ['read'])
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx, undefined),
    /parent agent unavailable for ownership-safe tool filtering/,
  )
})

test('native worker tool filter fails closed when the parent capability view contains no ownership-safe tools', () => {
  const { ctx, parent } = ctxWithTools(['read'], ['pwsh', 'git_commit', 'run_code'])
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx, parent),
    /no ownership-safe tools are available in the parent DSH profile/,
  )
})

test('native worker tool filter fails closed when the scoped catalog shape is invalid', () => {
  const parent = { id: 'parent' }
  const ctx = { tools: { schemas: agent => agent === parent ? null : schemasFor(['read']) } }
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx, parent),
    /tools\.schemas returned an invalid catalog for ownership-safe tool filtering/,
  )
})

test('native worker tool filter contains scoped catalog failures instead of broadening access', () => {
  const parent = { id: 'parent' }
  const ctx = { tools: { schemas: (agent) => {
    if (agent === parent) throw new Error('catalog offline')
    return schemasFor(['read'])
  } } }
  assert.throws(
    () => resolveOwnershipSafeToolAllow(ctx, parent),
    /tools\.schemas failed for ownership-safe tool filtering: catalog offline/,
  )
})
