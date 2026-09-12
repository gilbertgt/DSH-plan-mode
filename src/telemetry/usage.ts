export interface UsageSample{role:string;input?:number;uncachedInput?:number;cacheRead?:number;cacheWrite?:number;output?:number;turns?:number;durationMs?:number;provider?:string;model?:string;pressureTokens?:number;source:'dsh-token-projection'|'sdk-events'|'unavailable';estimated?:boolean}
const num=(v:any)=>Number.isFinite(v)?Number(v):undefined
export function sampleFromUnknown(role:string,value:any):UsageSample{return{role,input:num(value?.inputTokens),uncachedInput:num(value?.uncachedInputTokens),cacheRead:num(value?.cacheReadTokens),cacheWrite:num(value?.cacheWriteTokens),output:num(value?.outputTokens),turns:num(value?.turns),durationMs:num(value?.durationMs),provider:typeof value?.provider==='string'?value.provider:undefined,model:typeof value?.model==='string'?value.model:undefined,source:value?.source??'unavailable',estimated:Boolean(value?.estimated)}}
export function usageFromSession(ctx:any,role:string,session:any,route?:{provider?:string;model?:string}):UsageSample{
  try{
    const state=ctx.sessionProjections?.stateOf?.(session,'tokenUsage');const totals=state?.totals??state
    const uncached=num(totals?.uncachedInputTokens),read=num(totals?.cacheReadTokens),write=num(totals?.cacheWriteTokens),output=num(totals?.outputTokens)
    let pressure:number|undefined;try{pressure=num(ctx.get?.('tokenMeter')?.measure?.(session)?.totalTokens)}catch{}
    if([uncached,read,write,output].every(v=>typeof v==='number'))return{role,uncachedInput:uncached,cacheRead:read,cacheWrite:write,output,input:(uncached!+read!+write!),provider:route?.provider,model:route?.model,pressureTokens:pressure,source:'dsh-token-projection'}
  }catch{}
  return{role,provider:route?.provider,model:route?.model,source:'unavailable'}
}
function usageInEvent(event:any){if(event?.type==='assistant/message'&&event.data?.usage)return event.data.usage;const stream=event?.data?.stream;if(!Array.isArray(stream))return undefined;for(let i=stream.length-1;i>=0;i--){const u=stream[i]?.usage??stream[i]?.chunk?.usage;if(u)return u}return undefined}
export function usageFromSdkEvents(role:string,events:readonly any[],route?:{provider?:string;model?:string}):UsageSample{
  let uncached=0,read=0,write=0,output=0,samples=0;const seen=new Map<string,{uncached:number;read:number;write:number;output:number}>()
  for(const event of events){if(event?.type!=='assistant/message'&&event?.type!=='assistant/attempt'&&event?.type!=='llm/retry-started')continue
    if(event.type==='llm/retry-started'){seen.delete(`${event.data?.turn}:${event.data?.step}`);continue}
    const u=usageInEvent(event);if(!u)continue;const key=`${event.data?.turn}:${event.data?.step}`,next={uncached:Number(u.inputTokens??0),read:Number(u.cacheReadTokens??0),write:Number(u.cacheWriteTokens??0),output:Number(u.outputTokens??0)},prev=seen.get(key)
    if(prev){uncached-=prev.uncached;read-=prev.read;write-=prev.write;output-=prev.output}else samples++
    uncached+=next.uncached;read+=next.read;write+=next.write;output+=next.output;seen.set(key,next)
  }
  return samples?{role,uncachedInput:uncached,cacheRead:read,cacheWrite:write,output,input:uncached+read+write,turns:samples,provider:route?.provider,model:route?.model,source:'sdk-events'}:{role,provider:route?.provider,model:route?.model,source:'unavailable'}
}
