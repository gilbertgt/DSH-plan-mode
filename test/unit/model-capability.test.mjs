import test from 'node:test'
import assert from 'node:assert/strict'
import { modelCapability, modelCatalog, routeValidate } from '../../src/model-catalog.ts'
import { RPC_METHODS, boundedId, assertRpcBody } from '../../src/contract/rpc.ts'
import { registerRpc } from '../../src/rpc-server.ts'

/** One plausible `LlmResolvedModelInfo`: identity plus adapter-owned capability. */
const reasoningModel = {
  provider: 'deepseek', id: 'model-a', name: 'Model A',
  context: { contextWindow: 128_000 },
  defaultMaxTokens: 8_192,
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
}

test('model-capability is an additive RPC method that leaves the others intact', () => {
  assert.ok(RPC_METHODS.includes('model-capability'))
  // Every pre-existing method must survive unchanged, and the envelope shape is
  // untouched, so this is a purely additive contract change.
  for (const existing of ['model-catalog', 'route-validate', 'run-list', 'run-detail', 'run-cancel', 'run-resume', 'run-cleanup', 'diagnostics', 'external-preflight']) {
    assert.ok(RPC_METHODS.includes(existing), `${existing} must remain available`)
  }
  assert.equal(new Set(RPC_METHODS).size, RPC_METHODS.length, 'methods must stay unique')
})

test('capability is read from the owning adapter and reports only capability fields', async () => {
  const calls = []
  const ctx = {
    llm: {
      resolveModelInfo: async (provider, model, signal) => {
        calls.push({ provider, model, signal })
        // Adapter-private noise that must never reach the client.
        return { ...reasoningModel, adapterPrivate: { secret: 'nope' }, systemPromptUpdate: 'in-history' }
      },
    },
  }
  const result = await modelCapability(ctx, { provider: 'deepseek', model: 'model-a' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek')
  assert.equal(calls[0].model, 'model-a')
  assert.ok(calls[0].signal instanceof AbortSignal, 'the lookup must be cancellable/bounded')
  assert.deepEqual(result.reasoning, reasoningModel.reasoning)
  assert.equal(result.defaultMaxTokens, 8_192)
  assert.equal(result.contextWindow, 128_000)
  assert.equal(Object.hasOwn(result, 'adapterPrivate'), false)
  assert.equal(Object.hasOwn(result, 'systemPromptUpdate'), false)
  // No field named maxTokens: rc.1 declares no authoritative per-model ceiling.
  assert.equal(Object.hasOwn(result, 'maxTokens'), false)
})

test('a model without reasoning metadata reports no efforts rather than guessing', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'M', defaultMaxTokens: 4_096 }) } }
  const result = await modelCapability(ctx, { provider: 'p', model: 'm' })
  assert.equal(Object.hasOwn(result, 'reasoning'), false)
  assert.equal(Object.hasOwn(result, 'contextWindow'), false)
  assert.equal(result.defaultMaxTokens, 4_096)
  assert.equal(Object.hasOwn(result, 'maxTokens'), false)
  assert.equal(Object.hasOwn(result, 'unavailable'), false)
})

test('an unavailable or failing capability lookup degrades instead of fabricating options', async () => {
  // The API is absent entirely.
  const missing = await modelCapability({ llm: {} }, { provider: 'p', model: 'm' })
  assert.match(missing.unavailable, /resolveModelInfo is unavailable/)
  assert.equal(missing.provider, 'p')
  assert.equal(missing.model, 'm')
  assert.equal(Object.hasOwn(missing, 'reasoning'), false)

  // The adapter rejects.
  const throws = await modelCapability({ llm: { resolveModelInfo: async () => { throw new Error('adapter refused') } } }, { provider: 'p', model: 'm' })
  assert.equal(throws.unavailable, 'adapter refused')
  assert.equal(Object.hasOwn(throws, 'reasoning'), false)

  // The lookup is aborted; the abort must not escape as a transport failure.
  const aborted = await modelCapability({
    llm: { resolveModelInfo: async (_p, _m, signal) => { signal?.throwIfAborted?.(); throw new DOMException('Aborted', 'AbortError') } },
  }, { provider: 'p', model: 'm' })
  assert.ok(typeof aborted.unavailable === 'string' && aborted.unavailable.length > 0)
  assert.equal(Object.hasOwn(aborted, 'reasoning'), false)
})

test('the capability route answers ok:true with bounded input validation', async () => {
  const routes = new Map()
  const connection = { fetch: { register(definition) { routes.set(definition.path, definition.fetch); return () => routes.delete(definition.path) } } }
  let seen
  registerRpc(connection, {
    ctx: { llm: { resolveModelInfo: async (provider, model) => { seen = { provider, model }; return reasoningModel } } },
    isEnabled: () => true,
    canResume: () => true,
  })
  const post = (path, value) => routes.get(path)(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }))

  const ok = await post('/api/plan-orchestrator/model-capability', { provider: 'deepseek', model: 'model-a' })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.provider, 'deepseek')
  assert.deepEqual(seen, { provider: 'deepseek', model: 'model-a' })

  // A missing or oversized identifier is refused before the adapter is touched.
  for (const bad of [{}, { provider: '', model: 'm' }, { provider: 'p', model: 'x'.repeat(400) }, { provider: 42, model: 'm' }]) {
    const response = await post('/api/plan-orchestrator/model-capability', bad)
    assert.equal(response.status, 400, `${JSON.stringify(bad)} must be refused`)
    assert.equal((await response.json()).ok, false)
  }
})

test('route-validate still rejects a control an exact model does not accept', async () => {
  // The host's resolveCallConfig is the final authority: the UI must not be able
  // to save an effort the model does not offer.
  const llm = {
    resolveCallConfig: async config => {
      const supported = reasoningModel.reasoning.efforts.map(effort => effort.id)
      if (config.reasoningEffort !== undefined && !supported.includes(config.reasoningEffort)) {
        throw new Error(`model "${config.model}" does not support reasoning effort "${config.reasoningEffort}"`)
      }
      return config
    },
  }
  const accepted = await routeValidate({ llm }, { mode: 'fixed', provider: 'deepseek', model: 'model-a', reasoningEffort: 'high', fallbacks: [] })
  assert.equal(accepted.reasoningEffort, 'high')
  await assert.rejects(
    () => routeValidate({ llm }, { mode: 'fixed', provider: 'deepseek', model: 'model-a', reasoningEffort: 'bogus', fallbacks: [] }),
    /does not support reasoning effort/,
  )
  // Auto omits the property entirely, so nothing is validated against it.
  const auto = await routeValidate({ llm }, { mode: 'fixed', provider: 'deepseek', model: 'model-a', fallbacks: [] })
  assert.equal(Object.hasOwn(auto, 'reasoningEffort'), false)
})

test('the catalog still lists providers and models as before', async () => {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'model-a', name: 'Model A' }],
    },
  }
  const catalog = await modelCatalog(ctx)
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].provider.id, 'deepseek')
  assert.equal(catalog[0].models[0].id, 'model-a')
  assert.equal(catalog[0].error, undefined)
})

test('RPC input bounds behave as documented', () => {
  assert.equal(boundedId('ok', 'x'), 'ok')
  assert.throws(() => boundedId('', 'x'), /invalid/)
  assert.throws(() => boundedId('a\0b', 'x'), /invalid/)
  assert.throws(() => boundedId(5, 'x'), /invalid/)
  assert.deepEqual(assertRpcBody({ a: 1 }), { a: 1 })
  assert.throws(() => assertRpcBody([]), /JSON object/)
})
