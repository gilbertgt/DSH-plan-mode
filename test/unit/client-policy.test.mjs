import test from 'node:test'
import assert from 'node:assert/strict'
import { plannerPolicyText, PLANNER_POLICY, COMPACT_PLANNER_REMINDER } from '../../src/planning/policy.ts'
import { DEFAULT_SETTINGS } from '../../src/contract/settings.ts'
import { createRpc } from '../../src/client/rpc-client.ts'

test('Plan OFF and disabled states add zero planner contract text', () => {
  assert.equal(plannerPolicyText(true, false, true), '')
  assert.equal(plannerPolicyText(false, true, true), '')
  assert.equal(plannerPolicyText(false, false, false), '')
  assert.equal(plannerPolicyText(true, true, true), PLANNER_POLICY)
  assert.equal(plannerPolicyText(true, true, false), COMPACT_PLANNER_REMINDER)
  assert.ok(COMPACT_PLANNER_REMINDER.length < PLANNER_POLICY.length / 4)
})

test('planner orders clean-worktree validation producer before consumer', () => {
  assert.match(PLANNER_POLICY, /fresh detached worktree/)
  assert.match(PLANNER_POLICY, /Ignored, untracked, and generated artifacts from the originating workspace are absent/)
  assert.match(PLANNER_POLICY, /producer-before-consumer/)
  assert.match(PLANNER_POLICY, /package manager that owns the checked-in lockfile/)
  assert.match(PLANNER_POLICY, /implicit pre\/post lifecycle hook/)
  assert.match(PLANNER_POLICY, /consumer script explicitly produces its own prerequisites/)
  assert.match(PLANNER_POLICY, /tracked or non-ignored mutation fails validation/)
  assert.match(COMPACT_PLANNER_REMINDER, /clean-worktree producer-before-consumer/)
})

test('planner settings are runtime policy inputs rather than dead UI state',()=>{
  const planning={...structuredClone(DEFAULT_SETTINGS.planning),adaptiveResearch:false,maxInitialReadFiles:3,softInputTokens:12345,progressiveDiscovery:false,requireExpansionReason:true}
  const text=plannerPolicyText(true,true,true,planning)
  assert.match(text,/Adaptive research is disabled/)
  assert.match(text,/at most 3 files/)
  assert.match(text,/12345 tokens/)
  assert.match(text,/Progressive discovery is disabled/)
  assert.match(text,/package\.json script/)
})

test('client RPC uses authenticated same-origin exact API route', async () => {
  const calls = []
  const rpc = createRpc(async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, data: { answer: 42 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.deepEqual(await rpc('run-detail', { runId: 'r1' }), { answer: 42 })
  assert.equal(calls[0].url, '/api/plan-orchestrator/run-detail')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.method, 'POST')
})

test('client RPC fails closed on HTTP/API errors and malformed JSON', async () => {
  const api = createRpc(async () => new Response(JSON.stringify({ ok: false, error: { message: 'denied' } }), { status: 400 }))
  await assert.rejects(() => api('x'), /denied/)
  const malformed = createRpc(async () => new Response('not-json', { status: 500 }))
  await assert.rejects(() => malformed('x'), /invalid JSON/)
})
