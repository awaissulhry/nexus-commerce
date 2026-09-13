import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import Fastify from 'fastify'
import { databaseTarget } from '../step1/target.mjs'
const phase=process.argv[2]??'before';assert.ok(['before','after'].includes(phase))
const target=await databaseTarget('local');assert.equal(target.identity.database,'nexus_development')
const readOnlyUrl=new URL(target.connectionString);readOnlyUrl.searchParams.set('options','-c default_transaction_read_only=on')
Object.assign(process.env,{DATABASE_URL:readOnlyUrl.toString(),NEXUS_WORKSPACES_ENABLED:'0',NEXUS_DISABLE_BACKGROUND_JOBS:'1',ENABLE_QUEUE_WORKERS:'false'})
const transportAttempts=[];globalThis.__lxBlockedGateways=[]
const deny=()=>{transportAttempts.push(new Date().toISOString());throw new Error('External transport refused by readiness harness')}
https.request=deny;https.get=deny;http.request=deny;http.get=deny;globalThis.fetch=deny;syncBuiltinESMExports()
const runtime=await import(`./rehearsal-runtime-${phase}.mjs`)
const {prisma,inDatabaseTransaction}=runtime
const app=Fastify({logger:false});const sentinel=new Error('readonly rollback');let captured
app.addHook('onRoute',route=>{if(!String(route.url).endsWith('/readiness'))return;const handler=route.handler;route.handler=async function(req,reply){try{await inDatabaseTransaction(prisma,async()=>{captured=await handler.call(this,req,reply);throw sentinel})}catch(e){if(e!==sentinel)throw e}return captured}})
await app.register(runtime.studio,{prefix:'/api'})
const measurements=[]
try{for(let i=0;i<3;i++){const start=performance.now();const response=await app.inject({method:'GET',url:'/api/products/cmokmy3a40078pm0p1fvnu523/readiness?market=DE&locale=de'});assert.equal(response.statusCode,200,response.body);measurements.push({wallMs:Math.round((performance.now()-start)*10)/10,serverTiming:response.headers['server-timing'],body:response.json()})}
const result={phase,at:new Date().toISOString(),target:target.identity,readOnly:true,rolledBack:true,providerGatewaysBlocked:globalThis.__lxBlockedGateways,transportAttempts,measurements}
await fs.writeFile(new URL(`isolated-${phase}.json`,import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,measurements:measurements.map(m=>({wallMs:m.wallMs,serverTiming:m.serverTiming,scopes:m.body.scopes?.map(s=>({id:s.id,pct:s.pct,state:s.state}))}))}))
}finally{await app.close();await prisma.$disconnect()}
