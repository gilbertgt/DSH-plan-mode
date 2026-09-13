import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const profile = readFileSync(new URL('../../profiles/worker.cordis.yml', import.meta.url), 'utf8')

test('SDK worker overlay disables both shipped nested-subagent tools', () => {
  assert.match(profile, /- id: tool-subagent\s+disabled: true/)
  assert.match(profile, /- id: tool-subagent-fork\s+disabled: true/)
})
