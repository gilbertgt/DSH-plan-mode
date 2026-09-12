import test from 'node:test'
import assert from 'node:assert/strict'
import { installIssueCommand } from '../../src/external/issue-command.ts'
import { registerRpc } from '../../src/rpc-server.ts'

test('/plan-issue obeys top-level Enabled before any external execution path', async () => {
  let registration
  let approvals = 0
  const ctx = { commands: { register(value) { registration = value; return () => {} } } }
  installIssueCommand(ctx, {
    settings: () => ({ enabled: false, externalIssue: { enabled: true, publishAfterPass: false } }),
    orchestration: { approve() { approvals++; throw new Error('must not execute') } },
  })
  const result = await registration.handler({
    agent: { session: { id: 's1', header: { cwd: process.cwd() } } },
    rawInput: '4',
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Plan Orchestrator is disabled/)
  assert.equal(approvals, 0)
})

test('RPC blocks run-resume while disabled but preserves cleanup/control operations', async () => {
  const routes = new Map()
  const connection = {
    fetch: {
      register(definition) {
        routes.set(definition.path, definition.fetch)
        return () => routes.delete(definition.path)
      },
    },
  }
  let resumeCalls = 0
  let cancelCalls = 0
  registerRpc(connection, {
    ctx: {},
    isEnabled: () => false,
    canResume: () => true,
    runResume: async () => { resumeCalls++; return { ok: true } },
    runCancel: async ({ runId }) => { cancelCalls++; return { ok: true, runId } },
  })

  const request = (path, value) => new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
  const resume = await routes.get('/api/plan-orchestrator/run-resume')(
    request('/api/plan-orchestrator/run-resume', { runId: 'r1' }),
  )
  assert.equal(resume.status, 400)
  const resumeBody = await resume.json()
  assert.equal(resumeBody.ok, false)
  assert.match(resumeBody.error.message, /Plan Orchestrator is disabled/)
  assert.equal(resumeCalls, 0)

  const cancel = await routes.get('/api/plan-orchestrator/run-cancel')(
    request('/api/plan-orchestrator/run-cancel', { runId: 'r1' }),
  )
  assert.equal(cancel.status, 200)
  assert.deepEqual(await cancel.json(), { ok: true, data: { ok: true, runId: 'r1' } })
  assert.equal(cancelCalls, 1)
})

test('RPC blocks run-resume when Safe Resume is disabled even while orchestrator is enabled',async()=>{
  const routes=new Map()
  const connection={fetch:{register(definition){routes.set(definition.path,definition.fetch);return()=>{}}}}
  let resumeCalls=0
  registerRpc(connection,{
    ctx:{},isEnabled:()=>true,canResume:()=>false,
    runResume:async()=>{resumeCalls++;return{ok:true}},
  })
  const response=await routes.get('/api/plan-orchestrator/run-resume')(new Request('http://localhost/api/plan-orchestrator/run-resume',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:'r1'}),
  }))
  assert.equal(response.status,400)
  const body=await response.json();assert.equal(body.ok,false);assert.match(body.error.message,/Safe Resume is disabled/);assert.equal(resumeCalls,0)
})
