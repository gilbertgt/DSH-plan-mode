import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPlanArtifact, validatePlanArtifact } from '../../src/contract/plan-artifact.ts'
import { PLANNER_POLICY } from '../../src/planning/policy.ts'

/** A minimal artifact whose single task is satisfiable by a leaf Worker. */
function plan(overrides = {}) {
  return {
    planModeVersion: 1,
    summary: 'x',
    complexity: 'small',
    decisionLocks: [],
    tasks: [{
      id: 't1',
      title: 't',
      objective: 'o',
      read: ['src/a.ts'],
      modify: ['src/a.ts'],
      decisionLocks: [],
      requiredChanges: ['change a'],
      acceptanceCriteria: ['passes'],
      validation: ['npm test'],
      dependsOn: [],
      parallelSafe: false,
    }],
    validationStrategy: [],
    validationCommands: [{ id: 'unit', taskIds: ['t1'], command: 'npm test', timeoutMs: 1000 }],
    risks: [],
    outOfScope: [],
    ...overrides,
  }
}

function withRequiredChange(change) {
  const value = plan()
  value.tasks[0].requiredChanges = [change]
  return value
}

test('the policy states the worker capability boundary', () => {
  // The runtime guard below is the enforcement; the policy is what stops the
  // Planner from emitting an impossible task in the first place. Both must exist.
  assert.match(PLANNER_POLICY, /## Worker capability boundary/)
  assert.match(PLANNER_POLICY, /no shell, package-manager, process, or network execution tool/)
  assert.match(PLANNER_POLICY, /Host responsibilities/)
})

test('a task that only a Host with a shell could perform is rejected at validation', () => {
  // This is the exact shape that produced "worker client-select-readability:
  // BLOCKED": a leaf Worker was told to build and to copy outside the repo.
  const cases = [
    'Run npm ci and npm run build.',
    'Run npm run test:unit and npm run typecheck.',
    'Execute the build script.',
    'Install dependencies with npm.',
    'Copy lib/client.js to C:\\Users\\gilbe\\.dsh\\profiles\\web\\node_modules\\p\\lib\\.',
    'Copy the bundle into /home/user/.dsh/plugins.',
    'Deploy the artifact to the installed plugin directory.',
    'Run git status to confirm the branch.',
  ]
  for (const change of cases) {
    assert.throws(
      () => validatePlanArtifact(withRequiredChange(change)),
      /Worker|outside the repository|execute a program/,
      `${change} must be rejected`,
    )
  }
})

test('objective and acceptance criteria are guarded as well as required changes', () => {
  const byObjective = plan()
  byObjective.tasks[0].objective = 'Run npm run build to prove the bundle is current.'
  assert.throws(() => validatePlanArtifact(byObjective), /objective/)

  const byCriterion = plan()
  byCriterion.tasks[0].acceptanceCriteria = ['npm run typecheck exits 0.']
  assert.throws(() => validatePlanArtifact(byCriterion), /acceptanceCriteria/)

  const byExternalPath = plan()
  byExternalPath.tasks[0].acceptanceCriteria = ['The file exists at D:\\deploy\\out.js.']
  assert.throws(() => validatePlanArtifact(byExternalPath), /outside the repository/)
})

test('any absolute or out-of-repository path is rejected even without an execution verb', () => {
  for (const change of [
    'Write the result to C:/temp/out.txt.',
    'Update the copy at /etc/planx/conf.yml.',
    'Place the report in \\\\server\\share\\out.md.',
  ]) {
    assert.throws(() => validatePlanArtifact(withRequiredChange(change)), /outside the repository/, `${change} must be rejected`)
  }
})

test('legitimate descriptive prose about tools and packages still validates', () => {
  // The guard must not reject a plan that merely names a tool or a package.
  const cases = [
    'Add the @gilbertgt/dsh-plan-orchestrator entry to the bundle list.',
    'Document the npm package name in README.md.',
    'Set background to var(--dsw-alias-bg-layer-1,Canvas) in the select rule.',
    'Replace the deprecated git helper import with the structured one.',
    'The node field of the schema becomes optional.',
    'Rename buildScript to validationScript in src/contract/settings.ts.',
  ]
  for (const change of cases) {
    assert.doesNotThrow(() => validatePlanArtifact(withRequiredChange(change)), `${change} must be accepted`)
  }
})

test('the exact failed plan from the blocked run is now rejected', () => {
  // Verbatim shape of the required change that produced the BLOCKED run.
  const blocked = withRequiredChange(
    '建置與部署：於 repo 執行 npm ci 與 npm run build，確認 lib/client.js 反映新樣式；再將 lib/client.js 與 lib/client.js.map 覆蓋至 C:\\Users\\gilbe\\.dsh\\profiles\\web\\node_modules\\@gilbertgt\\dsh-plan-orchestrator\\lib\\ 下的同名檔案。',
  )
  assert.throws(() => validatePlanArtifact(blocked), /outside the repository|execute a program/)
})

test('a well-formed plan is still accepted end to end', () => {
  const { artifact, hash } = extractPlanArtifact(`# P\n\n\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``)
  assert.equal(artifact.tasks[0].id, 't1')
  assert.match(hash, /^[0-9a-f]{64}$/)
})
