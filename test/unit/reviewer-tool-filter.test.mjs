import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveReviewerToolAllow } from '../../src/orchestration/native-backend.ts'

/**
 * The verbatim global tool catalog reported by the failed run
 * (run 4fb2fdca-1d01-4d92-aed6-3a85fcd0e094, session 11b66d03-…).
 *
 * That run reached REVIEWING — its single unit validation receipt is a PASS —
 * and then died with:
 *
 *   tools.restrict() names unknown global tool "lsp";
 *   known global tools: ask_user_question, …, write
 *
 * The Reviewer filter was a hard-coded allow-list containing `lsp`, a tool this
 * composition does not register. DSH validates every named capability against
 * the inheriting scope's catalog and throws before the child is created, so the
 * run could never reach a verdict. This list is the exact reproduction input.
 */
const OBSERVED_GLOBAL_TOOLS = [
  'ask_user_question', 'codex_image_generate', 'create_goal', 'edit', 'exit_plan_mode', 'get_goal',
  'git_branch', 'git_checkout', 'git_commit', 'git_diff', 'git_fetch', 'git_log', 'git_pull', 'git_remote',
  'git_show', 'git_stage', 'git_stash', 'git_status', 'glob', 'grep', 'interrupt_agent', 'job_kill',
  'job_list', 'job_output', 'list_agents', 'present', 'pwsh', 'ralph', 'read', 'read_image', 'send_message',
  'skill', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch', 'web_search', 'workflow', 'write',
]

/** The exact filter that aborted the run. */
const HARD_CODED_REVIEWER_ALLOW = ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch']

function schemasFor(names) {
  return names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
}

function ctxWithCatalog(names) {
  const parent = { id: 'parent' }
  return { parent, ctx: { tools: { schemas: agent => (agent === parent ? schemasFor(names) : []) } } }
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

/**
 * A real ToolRuntime with `names` registered on the parent agent's own scope
 * layer, plus a child scope that inherits it — the exact composition DSH builds
 * before it applies a per-child `toolFilter`.
 */
async function realPresetWithChild(names) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const parent = { id: 'parent' }
  let parentScope
  await ctx.plugin(Object.assign(inner => { parentScope = createScope(inner, parent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  for (const name of names) parentScope.ctx.tools.register(tool(name))
  const child = { id: 'reviewer-child' }
  const childScope = createScope(parentScope.ctx, child, { parent })
  return {
    ctx,
    parent,
    childScope,
    dispose: async () => { await childScope.dispose(); await parentScope.dispose() },
  }
}

test('reviewer filter names only read-only tools this composition registers', () => {
  const { ctx, parent } = ctxWithCatalog(OBSERVED_GLOBAL_TOOLS)
  assert.deepEqual(resolveReviewerToolAllow(ctx, parent), ['read', 'glob', 'grep', 'web_search', 'web_fetch'])
})

test('reviewer filter never names a capability that is absent from the catalog', () => {
  const { ctx, parent } = ctxWithCatalog(OBSERVED_GLOBAL_TOOLS)
  const catalog = new Set(OBSERVED_GLOBAL_TOOLS)
  for (const name of resolveReviewerToolAllow(ctx, parent)) {
    assert.equal(catalog.has(name), true, `${name} must exist in the composition before it is named`)
  }
  assert.equal(resolveReviewerToolAllow(ctx, parent).includes('lsp'), false)
})

test('the resolved reviewer filter is accepted by the real DSH tools.restrict()', async (t) => {
  // This is the exact operation that threw before the fix. Resolving against the
  // live catalog is what makes it succeed.
  const { ctx, parent, childScope, dispose } = await realPresetWithChild(OBSERVED_GLOBAL_TOOLS)
  t.after(dispose)
  const allow = resolveReviewerToolAllow(ctx, parent)
  const release = childScope.ctx.tools.restrict({ allow })
  t.after(() => release())
  assert.deepEqual([...allow].sort(), ['glob', 'grep', 'read', 'web_fetch', 'web_search'])
})

test('the previous hard-coded reviewer filter is rejected by the real DSH restrict()', async (t) => {
  // Proves the regression test has teeth: naming `lsp` unconditionally fails
  // exactly where the run failed, so a future hard-coded list cannot pass here.
  const { childScope, dispose } = await realPresetWithChild(OBSERVED_GLOBAL_TOOLS)
  t.after(dispose)
  assert.throws(
    () => childScope.ctx.tools.restrict({ allow: HARD_CODED_REVIEWER_ALLOW }),
    /tools\.restrict\(\) names unknown global tool "lsp"/,
  )
})

test('reviewer filter keeps lsp when the composition really provides it', async (t) => {
  const withLsp = [...OBSERVED_GLOBAL_TOOLS, 'lsp']
  const { ctx, parent, childScope, dispose } = await realPresetWithChild(withLsp)
  t.after(dispose)
  const allow = resolveReviewerToolAllow(ctx, parent)
  assert.equal(allow.includes('lsp'), true)
  // No read-only capability is lost merely because lsp became available.
  assert.deepEqual([...allow].sort(), HARD_CODED_REVIEWER_ALLOW.slice().sort())
  const release = childScope.ctx.tools.restrict({ allow })
  t.after(() => release())
})

test('reviewer filter admits no mutation, shell, delegation, or control tool', async (t) => {
  // An allow-list of reading capabilities is the Reviewer's read-only guarantee.
  const { ctx, parent, dispose } = await realPresetWithChild([...OBSERVED_GLOBAL_TOOLS, 'lsp'])
  t.after(dispose)
  const allow = resolveReviewerToolAllow(ctx, parent)
  for (const denied of ['write', 'edit', 'pwsh', 'workflow', 'subagent_fork', 'send_message', 'run_code', 'apply_patch', 'delete', 'move']) {
    assert.equal(allow.includes(denied), false, `${denied} must never reach an independent Reviewer`)
  }
})

test('reviewer filter fails closed when the composition registers no read-only tool', () => {
  const { ctx, parent } = ctxWithCatalog(['write', 'edit', 'pwsh', 'workflow'])
  assert.throws(
    () => resolveReviewerToolAllow(ctx, parent),
    /no read-only tools are available in the parent DSH profile for the Reviewer role/,
  )
})

test('reviewer filter fails closed when the authoritative catalog API is unavailable', () => {
  assert.throws(
    () => resolveReviewerToolAllow({ tools: {} }, { id: 'parent' }),
    /tools\.schemas unavailable for reviewer read-only tool filtering/,
  )
})

test('reviewer filter fails closed without a parent agent', () => {
  const { ctx } = ctxWithCatalog(OBSERVED_GLOBAL_TOOLS)
  assert.throws(
    () => resolveReviewerToolAllow(ctx, undefined),
    /parent agent unavailable for reviewer read-only tool filtering/,
  )
})

test('reviewer filter contains a failing catalog lookup instead of widening access', () => {
  const parent = { id: 'parent' }
  const ctx = { tools: { schemas: () => { throw new Error('catalog offline') } } }
  assert.throws(
    () => resolveReviewerToolAllow(ctx, parent),
    /tools\.schemas failed for reviewer read-only tool filtering: catalog offline/,
  )
})
