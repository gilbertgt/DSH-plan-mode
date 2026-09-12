import type { RoleRoute } from './contract/settings.ts'
import { validateFixedRoute } from './planning/planner-route.ts'
export async function modelCatalog(ctx:any){const providers=ctx.llm.listProviders();return Promise.all(providers.map(async(p:any)=>{let models:any[]=[];let error:string|undefined;try{models=await ctx.llm.listModels(p.id)}catch(e){error=(e as Error).message}return{provider:{...p},models,error}}))}
export async function routeValidate(ctx:any,route:RoleRoute){return validateFixedRoute(ctx.llm,route)}
