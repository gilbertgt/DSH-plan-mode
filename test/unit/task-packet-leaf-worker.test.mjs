import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskPacket } from '../../src/orchestration/task-packet.ts'

const task = {
  id: 'leaf-worker',
  objective: 'change one file',
  read: ['src/a.ts'],
  modify: ['src/a.ts'],
  requiredChanges: ['make the requested change'],
  acceptanceCriteria: ['tests pass'],
  validation: ['npm test'],
  decisionLocks: [],
}

const plan = {
  decisionLocks: [],
  tasks: [task],
}

test('worker packet explicitly forbids nested/background delegation and reserves authoritative validation for host', () => {
  const packet = buildTaskPacket(plan, task)
  assert.match(packet, /you are a leaf Worker/i)
  assert.match(packet, /Do not spawn\/delegate to subagents, background agents, workflows, or agent-control tools/i)
  assert.match(packet, /Host validation is authoritative/i)
  assert.match(packet, /do not delegate validation to another agent/i)
})

test('worker packet treats Git baseline discovery as host-owned context instead of worker research', () => {
  const packet = buildTaskPacket(plan, task)
  assert.match(packet, /Host Git context is authoritative/i)
  assert.match(packet, /already established the repository\/worktree binding and baseline HEAD/i)
  assert.match(packet, /Do not inspect or resolve \.git internals/i)
  assert.match(packet, /do not re-check branch, HEAD, status, worktree metadata, or repository identity/i)
  assert.match(packet, /Start from the prioritized read targets and implement the assigned change/i)
})
