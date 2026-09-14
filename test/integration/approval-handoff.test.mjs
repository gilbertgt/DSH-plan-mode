import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../src/index.ts'
import { DEFAULT_SETTINGS } from '../../src/contract/settings.ts'
import { git } from '../../src/git/repository.ts'

const TEST_TIMEOUT = 60_000

/**
 * The approval handoff every real run depends on.
 *
 * `src/index.ts` is the only place where a settled native `exit_plan_mode`
 * becomes an orchestration run, and it was the one seam with no coverage: the
 * unit tests exercised `NativePlanBridge` and `OrchestrationService` separately,
 * never the wiring between them. A real run that reached REVIEWING and then died
 * at `tools.restrict()` showed how much that gap could hide.
 *
 * This lane mounts the production `apply()` and drives the exact event order DSH
 * produces: `tools/pre-execute` stages the candidate, `tools/result` consumes the
 * settled approval, and `agent/status: idle` launches the run.
 */

/**
 * Handlers registered by `apply()`, keyed by event name.
 *
 * `listeners` maps cordis event names to their registered handlers so a test can
 * address them directly, and `handlers` mirrors that for the middleware chain.
 */
function mountHost() {
  const listeners = new Map()
  const registered = { settings: undefined, projections: [] }

  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== handler))
    },
    effect(factory) { return factory() },
    inject(_names, factory) { return factory(ctx) },
    get(name) { return name === 'planMode' ? {} : undefined },
    logger: { warn() {}, error() {}, info() {} },
    settings: {
      register() {
        return {
          get: () => registered.settings,
          update: async value => { registered.settings = value },
          watch: () => () => {},
        }
      },
      writable: true,
    },
    sessionProjections: {
      register(definition) { registered.projections.push(definition) },
      stateOf: (session, key) => (key === 'plan' ? { active: Boolean(session.__planActive) } : undefined),
    },
    systemPrompt: { section() {}, getSectionOrder: () => 500 },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }), overrideOf: () => undefined },
    tools: {
      guard: () => () => {},
      schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }],
    },
    shell: { resolve: request => request, run: async () => ({ exitCode: 0 }) },
    llm: { resolveCallConfig: async choice => choice },
    // `apply()` also registers the external `/plan-issue` command.
    commands: { register: () => () => {} },
  }

  return { ctx, listeners, registered }
}

/**
 * Run one DSH middleware event the way cordis composes it: the registered
 * handlers form a chain in registration order, `next()` advances one step, and
 * the appended `terminal` function stands in for the native tool itself. A
 * handler that returns a decision other than `next()` short-circuits the chain,
 * which is exactly how a deny stops the native call.
 */
async function dispatchMiddleware(listeners, name, args, terminal) {
  const chain = listeners.get(name) ?? []
  const calls = { terminal: 0 }
  const run = async index => {
    if (index >= chain.length) {
      calls.terminal += 1
      return terminal()
    }
    // `args` is spread: the handler receives the DSH event payload first and the
    // `next` continuation second, exactly as cordis invokes it.
    return chain[index](...args, () => run(index + 1))
  }
  const outcome = await run(0)
  return { outcome, terminalCalls: calls.terminal }
}

function makeAgent(root) {
  const events = []
  return {
    status: 'busy',
    options: { provider: 'test-provider', model: 'test-model' },
    session: {
      id: 'planx-wiring-session',
      header: { cwd: root },
      append(type, data) {
        assert.notEqual(data, undefined, `${type} must carry JSON-serializable data`)
        events.push({ type, data: JSON.parse(JSON.stringify(data)) })
      },
      snapshotEvents() { return events },
    },
    inject() { return true },
    runMaintenance(fn) { return Promise.resolve().then(() => fn(new AbortController().signal)) },
    steer() {},
  }
}

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-wiring-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'test'])
  await git(root, ['config', 'core.autocrlf', 'false'])
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'a.ts'), 'base\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

const planArtifact = {
  planModeVersion: 1,
  summary: 'Wiring fixture.',
  complexity: 'small',
  decisionLocks: [],
  tasks: [{
    id: 't1',
    title: 't',
    objective: 'o',
    read: ['a.ts'],
    modify: ['a.ts'],
    decisionLocks: [],
    requiredChanges: ['change a.ts'],
    acceptanceCriteria: ['ok'],
    validation: [],
    dependsOn: [],
    parallelSafe: false,
  }],
  validationStrategy: [],
  validationCommands: [],
  risks: [],
  outOfScope: [],
}
const planText = `# Wiring plan\n\n\`\`\`json\n${JSON.stringify(planArtifact)}\n\`\`\``

const settle = () => new Promise(resolve => setTimeout(resolve, 200))

/** Wait for a predicate instead of guessing how long the real runner needs. */
async function waitFor(predicate, { timeoutMs = 30_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

/**
 * Run `body` against a plugin instance whose artifact store is redirected into a
 * throwaway `DSH_HOME`. `apply()` constructs its own `RunStore`, which resolves
 * `DSH_HOME` at call time, so the real orchestration state directory is never
 * touched by these tests.
 */
async function withIsolatedState(body) {
  const stateHome = await mkdtemp(join(tmpdir(), 'planx-wiring-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = stateHome
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await cleanup(stateHome)
  }
}

test('a validated, natively approved plan launches exactly one orchestration run', { timeout: TEST_TIMEOUT }, async () => {
  const root = await fixtureRepo()
  try {
    await withIsolatedState(async () => {
      const { ctx, listeners } = mountHost()
      apply(ctx)

      const agent = makeAgent(root)
      agent.session.__planActive = true
      const exec = { name: 'exit_plan_mode', callId: 'call-1', arguments: { plan: planText }, agent }

      // The native exit must still be reached: this plugin validates the plan,
      // it does not replace the native approval flow.
      let nativeCalls = 0
      const pass = await dispatchMiddleware(listeners, 'tools/pre-execute', [exec], async () => {
        nativeCalls += 1
        return { kind: 'allow' }
      })
      assert.notEqual(pass.outcome?.kind, 'deny', `an executable plan must not be denied: ${pass.outcome?.reason}`)
      assert.equal(nativeCalls, 1, 'the native tool must be reached exactly once')

      // rc.1 reports a successful approval as the structured `{ approved: true }`.
      for (const handler of listeners.get('tools/result') ?? []) {
        await handler(exec, { isError: false, value: { approved: true } })
      }

      for (const handler of listeners.get('agent/status') ?? []) {
        await handler({ agent, status: 'idle' })
      }
      await settle()

      const events = agent.session.snapshotEvents()
      const approved = events.filter(event => event.type === 'planx/run-approved')
      assert.equal(approved.length, 1, 'exactly one run may be approved for one settled handoff')
      assert.equal(approved[0].data.tasksTotal, 1)
      assert.equal(approved[0].data.sessionId, agent.session.id)
      assert.match(String(approved[0].data.planHash), /^[0-9a-f]{64}$/, 'the plan hash must be the artifact hash')

      // The launched run must converge on a terminal phase rather than staying
      // APPROVED_PENDING forever. This fixture has no subagent backend, so the
      // engine fails closed on worker route preflight.
      await waitFor(
        () => agent.session.snapshotEvents().some(event => event.type === 'planx/run-terminal'),
        { label: 'a terminal phase for the launched run' },
      )
      const terminal = agent.session.snapshotEvents().filter(event => event.type === 'planx/run-terminal')
      assert.notEqual(terminal.at(-1).data.phase, 'COMPLETE', 'a fixture with no worker backend cannot complete')
    })
  } finally {
    await cleanup(root)
  }
})

test('a plan without the JSON artifact fence is denied before the native tool', { timeout: TEST_TIMEOUT }, async () => {
  const root = await fixtureRepo()
  try {
    await withIsolatedState(async () => {
      const { ctx, listeners } = mountHost()
      apply(ctx)

      const agent = makeAgent(root)
      agent.session.__planActive = true
      const exec = { name: 'exit_plan_mode', callId: 'call-bad', arguments: { plan: '# Plan with no JSON fence' }, agent }

      let nativeCalls = 0
      const gate = await dispatchMiddleware(listeners, 'tools/pre-execute', [exec], async () => {
        nativeCalls += 1
        return { kind: 'allow' }
      })

      assert.equal(gate.outcome?.kind, 'deny')
      assert.match(String(gate.outcome?.reason), /invalid executable PlanArtifact/)
      assert.equal(nativeCalls, 0, 'a rejected plan must never reach the native exit tool')

      // Even a successful native settlement cannot launch a run: nothing staged.
      for (const handler of listeners.get('tools/result') ?? []) {
        await handler(exec, { isError: false, value: { approved: true } })
      }
      for (const handler of listeners.get('agent/status') ?? []) {
        await handler({ agent, status: 'idle' })
      }
      await settle()
      assert.equal(
        agent.session.snapshotEvents().some(event => event.type === 'planx/run-approved'),
        false,
        'no run may launch without a validated staged artifact',
      )
    })
  } finally {
    await cleanup(root)
  }
})

test('a native rejection or a disabled orchestrator never launches a run', { timeout: TEST_TIMEOUT }, async () => {
  const root = await fixtureRepo()
  try {
    await withIsolatedState(async () => {
      const { ctx, listeners, registered } = mountHost()
      apply(ctx)
      const agent = makeAgent(root)
      agent.session.__planActive = true

      const staged = async callId => {
        const exec = { name: 'exit_plan_mode', callId, arguments: { plan: planText }, agent }
        await dispatchMiddleware(listeners, 'tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
        return exec
      }
      const launchOnIdle = async () => {
        for (const handler of listeners.get('agent/status') ?? []) await handler({ agent, status: 'idle' })
        await settle()
      }
      const approvedRuns = () => agent.session.snapshotEvents().filter(event => event.type === 'planx/run-approved').length

      // Case A: the native approval UI settles with a rejection.
      const rejected = await staged('call-reject')
      for (const handler of listeners.get('tools/result') ?? []) {
        await handler(rejected, { isError: false, value: { approved: false } })
      }
      await launchOnIdle()
      assert.equal(approvedRuns(), 0, 'a rejected approval must not launch a run')

      // Case B: the operator disabled the plugin while the approval was open.
      const disabled = await staged('call-disabled')
      registered.settings = { ...DEFAULT_SETTINGS, enabled: false }
      for (const handler of listeners.get('tools/result') ?? []) {
        await handler(disabled, { isError: false, value: { approved: true } })
      }
      await launchOnIdle()
      assert.equal(approvedRuns(), 0, 'a disabled orchestrator must not launch a run')
    })
  } finally {
    await cleanup(root)
  }
})
