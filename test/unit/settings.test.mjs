import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, effectiveRoleRoute, validateSettings } from '../../src/contract/settings.ts'

const fresh=()=>structuredClone(DEFAULT_SETTINGS)

test('settings reject unknown fields and immutable security toggles',()=>{
  const unknown=fresh();unknown.extra=true
  assert.throws(()=>validateSettings(unknown),/unknown field/)
  const ownership=fresh();ownership.execution.requireExplicitOwnership=false
  assert.throws(()=>validateSettings(ownership),/security invariant/)
  const receipts=fresh();receipts.review.trustedValidation=false
  assert.throws(()=>validateSettings(receipts),/security invariant/)
})

test('workspace inherit/current/fixed routing is explicit',()=>{
  const key='workspace_key_123456'
  const settings=fresh();settings.roles.worker={mode:'fixed',provider:'p',model:'m',fallbacks:[]}
  settings.workspaceOverrides[key]={roles:{worker:{mode:'inherit',fallbacks:[]}}}
  assert.deepEqual(effectiveRoleRoute(validateSettings(settings),'worker',key),{mode:'fixed',provider:'p',model:'m',fallbacks:[]})
  settings.workspaceOverrides[key].roles.worker={mode:'current',fallbacks:[]}
  assert.deepEqual(effectiveRoleRoute(validateSettings(settings),'worker',key),{mode:'current',fallbacks:[]})
  settings.workspaceOverrides[key].roles.worker={mode:'fixed',provider:'wp',model:'wm',fallbacks:[]}
  assert.deepEqual(effectiveRoleRoute(validateSettings(settings),'worker',key),{mode:'fixed',provider:'wp',model:'wm',fallbacks:[]})
})

test('host settings registration is live and validates through authoritative PlanSettings parser', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../../src/settings-service.ts', import.meta.url), 'utf8')
  assert.match(source, /applies:\s*['"]live['"]/)
  assert.match(source, /validate:\s*\(value:\s*unknown\).*validateSettings\(value\)/s)
})
