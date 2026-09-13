import test from 'node:test'
import assert from 'node:assert/strict'
import { canAuthorExternalControl, trustedIssueTexts } from '../../src/external/github.ts'
import { NativeSpawnBackend } from '../../src/orchestration/native-backend.ts'
import { configureRoleTimeoutResolver } from '../../src/runtime-policy.ts'

test('external issue control accepts only repository writers and above',async()=>{
  assert.equal(canAuthorExternalControl('admin'),true)
  assert.equal(canAuthorExternalControl('maintain'),true)
  assert.equal(canAuthorExternalControl('write'),true)
  assert.equal(canAuthorExternalControl('triage'),false)
  assert.equal(canAuthorExternalControl('read'),false)
  assert.equal(canAuthorExternalControl(undefined),false)
  const issue={
    body:'owner-plan',author:{login:'owner'},comments:[
      {body:'attacker-higher-revision',author:{login:'stranger'}},
      {body:'writer-completion',author:{login:'writer'}},
      {body:'reader-plan',author:{login:'reader'}},
    ],
  }
  const permissions={owner:'admin',stranger:undefined,writer:'write',reader:'read'}
  const texts=await trustedIssueTexts('.', 'o/r', issue, async(_cwd,_repo,login)=>permissions[login])
  assert.deepEqual(texts,['owner-plan','writer-completion'])
})

test('native mutating roles expose only registered ownership-guarded file tools, never shell/run-code',async()=>{
  let captured
  const ctx={
    on(){return()=>{}},
    tools:{
      guard(){return()=>{}},
      schemas(){return ['read','write','edit','apply_patch','pwsh','run_code'].map(name=>({name}))},
    },
    subagents:{
      async start(_kind,options){
        captured=options
        return{
          localAgent:null,
          result:Promise.resolve({stopReason:'completed',structured:{taskId:'t1',status:'COMPLETE',changed:[],validation:[],remaining:[],contextExpansion:[]}}),
          async dispose(){},
        }
      },
    },
  }
  const restore=configureRoleTimeoutResolver(()=>1_000)
  try{
    const backend=new NativeSpawnBackend(ctx)
    const parent={session:{id:'parent',header:{cwd:process.cwd()}}}
    await backend.run({
      parent,role:'worker',taskId:'t1',prompt:'x',route:{provider:'p',model:'m'},signal:new AbortController().signal,
      ownership:{root:process.cwd(),paths:['src/a.ts']},
    })
    const allow=captured.toolFilter.allow
    for(const denied of ['bash','pwsh','shell','run_code','mkdir','write_file','edit_file'])assert.equal(allow.includes(denied),false)
    for(const permitted of ['read','write','edit','apply_patch'])assert.equal(allow.includes(permitted),true)
    assert.notEqual(captured.signal,undefined)
  }finally{restore()}
})
