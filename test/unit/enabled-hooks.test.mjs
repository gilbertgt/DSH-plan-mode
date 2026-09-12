import test from 'node:test'
import assert from 'node:assert/strict'
import { NativePlanBridge, consumeApprovedPlanResult, installExitPlanValidator } from '../../src/planning/native-plan-bridge.ts'
import { installPlannerRoute } from '../../src/planning/planner-route.ts'
import { PlannerReadOnlyGuard } from '../../src/planning/read-only-guard.ts'
import { installEnabledParentFence } from '../../src/orchestration/enabled-parent-fence.ts'

const artifact = {
  planModeVersion: 1,
  summary: 'x',
  complexity: 'small',
  decisionLocks: [],
  tasks: [{
    id: 't1', title: 't', objective: 'o', read: ['src/a.ts'], modify: ['src/a.ts'], decisionLocks: [],
    requiredChanges: ['x'], acceptanceCriteria: ['passes'], validation: ['npm test'], dependsOn: [], parallelSafe: false,
  }],
  validationStrategy: [],
  validationCommands: [{ id: 'unit', taskIds: ['t1'], command: 'npm test', timeoutMs: 1000 }],
  risks: [],
  outOfScope: [],
}
const planText = `# Plan\n\n\`\`\`json\n${JSON.stringify(artifact)}\n\`\`\``

function captureContext(extra = {}) {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      ...extra,
      on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
    },
  }
}

test('exit_plan_mode validator is a live Enabled gate, not an install-time gate', async () => {
  const bridge = new NativePlanBridge()
  const { ctx, handlers } = captureContext()
  let enabled = false
  let nativeCalls = 0
  installExitPlanValidator(ctx, bridge, () => true, () => enabled)
  const exec = {
    name: 'exit_plan_mode', callId: 'c1', arguments: { plan: 'not a PlanArtifact' },
    agent: { session: { id: 's1', header: { cwd: process.cwd() } } },
  }
  const native = async () => { nativeCalls++; return { kind: 'allow' } }
  assert.deepEqual(await handlers.get('tools/pre-execute')(exec, native), { kind: 'allow' })
  assert.equal(nativeCalls, 1)
  assert.equal(bridge.get('s1', 'c1'), undefined)

  enabled = true
  const denied = await handlers.get('tools/pre-execute')(exec, native)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /Plan Orchestrator: invalid executable PlanArtifact\/preflight/)
  assert.equal(nativeCalls, 1)
})

test('turning Enabled OFF while approval is open consumes the staged plan without handoff', () => {
  const bridge = new NativePlanBridge()
  const exec = { name: 'exit_plan_mode', callId: 'c2', agent: { session: { id: 's2' } } }
  bridge.stage('s2', 'c2', planText, 'deadbeef', false)
  assert.equal(consumeApprovedPlanResult(bridge, exec, { isError: false, value: { approved: true } }, () => false), undefined)
  assert.equal(bridge.get('s2', 'c2'), undefined)

  bridge.stage('s2', 'c2', planText, 'deadbeef', false)
  assert.equal(consumeApprovedPlanResult(bridge, exec, { isError: false, value: { approved: true } }, () => true)?.artifact.tasks[0].id, 't1')
})

test('planner route is exact native pass-through while disabled and resumes live when enabled', async () => {
  let enabled = false
  const resolved = []
  const { ctx, handlers } = captureContext({ llm: { resolveCallConfig: async route => { resolved.push(route) } } })
  installPlannerRoute(
    ctx,
    () => ({ mode: 'fixed', provider: 'custom', model: 'planner', fallbacks: [] }),
    () => true,
    () => enabled,
  )
  const agent = { options: { provider: 'native', model: 'native' } }
  const native = { provider: 'native', model: 'native', maxTokens: 123 }
  assert.deepEqual(await handlers.get('agent/request')({ agent }, async () => native), native)
  assert.equal(resolved.length, 0)

  enabled = true
  const routed = await handlers.get('agent/request')({ agent }, async () => native)
  assert.equal(routed.provider, 'custom')
  assert.equal(routed.model, 'planner')
  assert.equal(resolved.length, 1)
})

test('strict read-only tool guard does not block native tools while disabled', async () => {
  const guard = new PlannerReadOnlyGuard()
  const events = []
  const session = {
    id: 's3',
    append(type, data) { events.push({ type, data }) },
    snapshotEvents() { return events },
  }
  const sandboxPolicy = {
    resolve: () => ({ mode: 'workspace-write' }),
    overrideOf: () => undefined,
  }
  guard.activate(session, sandboxPolicy)
  assert.equal(guard.active('s3'), true)

  let enabled = false
  const { ctx, handlers } = captureContext()
  guard.install(ctx, () => enabled)
  const exec = { name: 'write', agent: { session } }
  assert.equal(await handlers.get('tools/pre-execute')(exec, async () => 'native'), 'native')

  enabled = true
  const blocked = await handlers.get('tools/pre-execute')(exec, async () => 'native')
  assert.equal(blocked.kind, 'deny')
})

test('parent fence passes through and cancels pending or active plugin run while disabled', async () => {
  let enabled = false
  let cancelled = 0
  let idleLaunches = 0
  let pending = true
  const service = {
    shouldFence: () => pending,
    cancelSession: async () => { cancelled++; pending = false; return true },
    onParentIdle: async () => { idleLaunches++; return true },
  }
  const { ctx, handlers } = captureContext({ logger: { warn() {}, error() {} } })
  installEnabledParentFence(ctx, service, () => enabled)
  const agent = { session: { id: 's4' } }
  let nativeCalls = 0
  const native = async () => { nativeCalls++; return { kind: 'native' } }

  assert.deepEqual(await handlers.get('agent/pre-step')({ agent }, native), { kind: 'native' })
  assert.equal(nativeCalls, 1)
  assert.equal(cancelled, 1)
  assert.equal(idleLaunches, 0)

  pending = true
  enabled = true
  assert.deepEqual(await handlers.get('agent/pre-step')({ agent }, native), { kind: 'reject' })
  assert.equal(nativeCalls, 2)

  enabled = false
  handlers.get('agent/status')({ agent, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, 2)
  assert.equal(idleLaunches, 0)

  pending = false
  enabled = true
  handlers.get('agent/status')({ agent, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(idleLaunches, 1)
})
