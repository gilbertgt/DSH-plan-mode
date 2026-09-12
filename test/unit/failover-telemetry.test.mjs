import test from 'node:test'
import assert from 'node:assert/strict'
import { eligibleTransportFailure, withPreMutationFailover } from '../../src/orchestration/failover.ts'
import { usageFromSdkEvents } from '../../src/telemetry/usage.ts'
import { aggregateUsage } from '../../src/telemetry/aggregate.ts'

test('failover only retries eligible transport/provider failures and stops at second failure',async()=>{
  assert.equal(eligibleTransportFailure(new Error('429 rate limit')),true)
  assert.equal(eligibleTransportFailure(new Error('policy refusal')),false)
  let calls=0
  const routes=[{provider:'a',model:'m'},{provider:'b',model:'m'}]
  const out=await withPreMutationFailover(routes,async route=>{calls++;if(route.provider==='a')throw new Error('transport reset');return route.provider})
  assert.equal(out,'b');assert.equal(calls,2)
  await assert.rejects(()=>withPreMutationFailover(routes,async()=>{throw new Error('transport reset')}),/transport reset/)
})

test('SDK usage keeps cache buckets and unavailable remains unavailable',()=>{
  const sample=usageFromSdkEvents('worker',[{type:'assistant/message',data:{turn:1,step:1,usage:{inputTokens:10,cacheReadTokens:20,cacheWriteTokens:3,outputTokens:4}}}],{provider:'p',model:'m'})
  assert.deepEqual({input:sample.input,uncached:sample.uncachedInput,read:sample.cacheRead,write:sample.cacheWrite,output:sample.output}, {input:33,uncached:10,read:20,write:3,output:4})
  const missing=usageFromSdkEvents('worker',[],{provider:'p',model:'m'})
  assert.equal(missing.source,'unavailable');assert.equal(missing.input,undefined)
  const agg=aggregateUsage([sample,missing])
  assert.equal(agg.input,undefined);assert.equal(agg.costUsd,undefined)
})
