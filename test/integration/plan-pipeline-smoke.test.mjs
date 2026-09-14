import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationService } from '../../src/orchestration/service.ts'
import { createOrchestratorRunner } from '../../src/orchestration/engine.ts'
import { configureValidationShell } from '../../src/validation/runner.ts'
import { configureRoleTimeoutResolver } from '../../src/runtime-policy.ts'
import { DEFAULT_SETTINGS } from '../../src/contract/settings.ts'
import { RunStore } from '../../src/recovery/store.ts'
import { git } from '../../src/git/repository.ts'

const TEST_TIMEOUT = 60_000

/**
 * The end-to-end Plan pipeline: approval → Worker → Host validation → Reviewer →
 * COMPLETE.
 *
 * Every previous orchestration blocker was found by a real run rather than by a
 * test, because the suite only ever exercised one stage at a time. This lane
 * drives the production `OrchestrationService` and the production
 * `createOrchestratorRunner` against a real Git repository and a real isolated
 * validation worktree, stubbing only the two model boundaries DSH owns: the
 * subagent that performs the Worker edit and the subagent that returns the
 * Reviewer verdict. Host validation is the real runner.
 */

/** A minimal but genuine repository the engine can worktree and validate. */
async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'planx-pipeline-'))
  await git(root, ['init'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'test'])
  // Validation provisioning compares the originating workspace bytes with the
  // detached worktree checkout. This host's system Git sets `core.autocrlf=true`,
  // which would rewrite the hand-written fixture's LF endings on checkout and
  // make the two sides differ for a reason that has nothing to do with the
  // pipeline. Pin the fixture repository to store bytes verbatim.
  await git(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, 'a.ts'), 'base\n')
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'planx-pipeline-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { 'test:unit': 'node --version' },
  }, null, 2)}\n`)
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'planx-pipeline-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'planx-pipeline-fixture', version: '1.0.0' } },
  }, null, 2)}\n`)
  // Validation dependency provisioning copies the originating node_modules into
  // the detached validation worktree, so the fixture ships a real (tiny) one.
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'fixture-dep.js'), 'export default 1\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'base'])
  return root
}

const artifact = {
  planModeVersion: 1,
  summary: 'Rewrite the single fixture file.',
  complexity: 'small',
  decisionLocks: ['Only a.ts may change.'],
  tasks: [{
    id: 't1',
    title: 'Rewrite a.ts',
    objective: 'Change the first line of a.ts.',
    read: ['a.ts'],
    modify: ['a.ts'],
    decisionLocks: [],
    requiredChanges: ['Replace the first line of a.ts with worker output.'],
    acceptanceCriteria: ['a.ts contains the worker line.'],
    validation: ['Host validation runs the configured package script.'],
    dependsOn: [],
    parallelSafe: false,
  }],
  validationStrategy: ['Trusted host validation runs npm run test:unit in a detached worktree.'],
  validationCommands: [{ id: 'unit', taskIds: ['t1'], command: 'npm run test:unit', timeoutMs: 30_000 }],
  risks: [],
  outOfScope: [],
}

function shellResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: { text: 'ok\n', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full', runnerFailed: false },
  }
}

/** One service + agent pair wiring the real engine, store and validation runner. */
function harness({ root, stateRoot }) {
  const events = []
  const seen = { workers: 0, reviewers: 0, validationCommands: [], reviewerToolFilter: undefined }

  const catalog = ['read', 'write', 'edit']
  const ctx = {
    llm: { resolveCallConfig: async choice => choice },
    tools: {
      // A live catalog without `lsp`: the exact shape that aborted a real run.
      schemas: () => catalog.map(name => ({ name })),
      guard: () => () => {},
    },
    on: () => () => {},
    subagents: {
      start: async (_mode, options) => {
        if (options.outputSchema) {
          seen.workers += 1
          // The Worker's real effect: mutate its exact owned path.
          await writeFile(join(root, 'a.ts'), 'worker output\n')
          return {
            result: Promise.resolve({
              stopReason: 'completed',
              structured: {
                taskId: 't1',
                status: 'COMPLETE',
                changed: ['a.ts'],
                validation: [],
                remaining: [],
                contextExpansion: [],
              },
            }),
            localAgent: undefined,
            dispose: async () => {},
          }
        }
        seen.reviewers += 1
        seen.reviewerToolFilter = options.toolFilter
        return {
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: '[REVIEW:PASS]\nThe owned change satisfies the plan.' }],
          }),
          localAgent: undefined,
          dispose: async () => {},
        }
      },
    },
  }

  const store = new RunStore(stateRoot)
  const settings = () => ({
    ...structuredClone(DEFAULT_SETTINGS),
    execution: {
      ...DEFAULT_SETTINGS.execution,
      maxParallelWorkers: 1,
      parallelMode: 'serial',
      keepFailedWorktrees: false,
      roleTimeoutMs: 30_000,
    },
    review: { ...DEFAULT_SETTINGS.review, maxReviewRounds: 1, protocolRetry: 0, outputCapBytes: 1024 * 1024 },
  })

  let service
  const emit = (kind, data) => service.recordEvent(kind, data)
  const runner = createOrchestratorRunner({ ctx, settings, store, emit })

  const sessionEvents = []
  const agentInstance = {
    status: 'busy',
    options: { provider: 'test-provider', model: 'test-model' },
    session: {
      id: 'planx-pipeline-session',
      header: { cwd: root },
      append(type, data) {
        assert.notEqual(data, undefined, `${type} must carry data`)
        sessionEvents.push({ type, data: JSON.parse(JSON.stringify(data)) })
      },
      snapshotEvents() { return sessionEvents },
    },
    inject() { return true },
    runMaintenance(fn) { return Promise.resolve().then(() => fn(new AbortController().signal)) },
  }

  service = new OrchestrationService(store, runner)
  return { service, store, agent: agentInstance, events, seen, catalog }
}

async function waitFor(predicate, { timeoutMs = 30_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

test('a plan runs approval, worker, host validation, review and reaches COMPLETE', { timeout: TEST_TIMEOUT }, async () => {
  const root = await fixtureRepo()
  const stateRoot = await mkdtemp(join(tmpdir(), 'planx-pipeline-state-'))
  const restoreShell = configureValidationShell({
    resolve: request => request,
    run: async request => {
      // The engine hands the resolved executable command to the host shell.
      assert.match(request.command, /test:unit/, 'host validation must run the planned package script')
      return shellResult()
    },
  })
  const restoreTimeout = configureRoleTimeoutResolver(() => 30_000)
  try {
    const { service, store, agent, seen, catalog } = harness({ root, stateRoot })
    const runId = service.approve({ sessionId: agent.session.id, agent, artifact, planHash: 'smoke-plan-hash' })
    assert.equal(typeof runId, 'string')
    assert.equal(await service.onParentIdle(agent.session.id), true)

    await waitFor(() => store.readManifest(agent.session.id, runId).then(m => m.terminal, () => false), { label: 'terminal manifest' })

    const manifest = await store.readManifest(agent.session.id, runId)
    const view = service.list(agent.session.id).find(item => item.runId === runId)
    assert.equal(manifest.phase, 'COMPLETE', `run must complete end to end, got ${manifest.phase}: ${view?.message ?? ''}`)
    assert.equal(manifest.terminal, true)

    // Every stage actually ran.
    assert.equal(seen.workers, 1, 'exactly one Worker delegation')
    assert.equal(seen.reviewers, 1, 'exactly one Reviewer delegation')

    const runDir = store.runDir(agent.session.id, runId)
    const completion = JSON.parse(await readFile(join(runDir, 'completion.json'), 'utf8'))
    assert.equal(completion.review, 'PASS')
    assert.deepEqual(completion.changedPaths, ['a.ts'])
    assert.equal(completion.receipts.length, 1)
    assert.equal(completion.receipts[0].commandId, 'unit')
    assert.equal(completion.receipts[0].status, 'PASS')

    // The trusted receipt is the real validation runner's receipt, not a stub.
    const receipt = JSON.parse(await readFile(join(runDir, 'validation', 'validating-unit.receipt.json'), 'utf8'))
    assert.equal(receipt.status, 'PASS')
    assert.equal(receipt.complete, true)
    assert.equal(receipt.command, 'npm run test:unit')
    assert.equal(receipt.boundHead, manifest.baselineHead)

    // The reviewed change is the Worker's real edit.
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'worker output\n')

    // The run view ends in COMPLETE.
    assert.equal(view?.phase, 'COMPLETE')

    const emitted = agent.session.snapshotEvents()
    const phaseOrder = emitted.filter(event => event.type === 'planx/run-phase').map(event => event.data.phase)
    for (const phase of ['PREFLIGHT', 'WORKERS', 'VALIDATING', 'REVIEWING', 'COMPLETE']) {
      assert.ok(phaseOrder.includes(phase), `phase ${phase} must be emitted, saw ${phaseOrder.join(' -> ')}`)
    }
    assert.ok(
      phaseOrder.indexOf('WORKERS') < phaseOrder.indexOf('VALIDATING')
      && phaseOrder.indexOf('VALIDATING') < phaseOrder.indexOf('REVIEWING')
      && phaseOrder.indexOf('REVIEWING') < phaseOrder.indexOf('COMPLETE'),
      `phases must run in pipeline order, saw ${phaseOrder.join(' -> ')}`,
    )

    // The Reviewer was restricted to exactly the read-only tools this
    // composition registers. The security property is a subset relationship: a
    // name absent from the live catalog (the `lsp` that aborted a real run) must
    // never reach the spawn, and no mutation surface may ever be allowed.
    const allowed = seen.reviewerToolFilter?.allow
    assert.ok(Array.isArray(allowed), 'the Reviewer spawn must carry a resolved allow-list')
    assert.ok(allowed.includes('read'), `the Reviewer must keep read, got ${JSON.stringify(allowed)}`)
    assert.deepEqual(
      allowed.filter(name => !catalog.includes(name)),
      [],
      'no unregistered capability may be named to tools.restrict()',
    )
    for (const mutator of ['write', 'edit', 'delete', 'move', 'apply_patch', 'patch']) {
      assert.equal(allowed.includes(mutator), false, `the read-only Reviewer must never hold ${mutator}`)
    }

    assert.equal(
      emitted.some(event => event.type === 'planx/run-terminal' && event.data.phase === 'COMPLETE'),
      true,
      'the terminal session event must report COMPLETE',
    )
  } finally {
    restoreTimeout()
    restoreShell()
    await cleanup(root)
    await cleanup(stateRoot)
  }
})
