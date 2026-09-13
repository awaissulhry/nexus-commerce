/** Fixed XAVIA local rehearsal host; never accepts a remote database or a publish route. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import Fastify from 'fastify'
import { databaseTarget } from '../step1/target.mjs'
const target=await databaseTarget('local')
assert.equal(target.identity.database,'nexus_development')
process.env.DATABASE_URL=target.connectionString
process.env.NEXUS_WORKSPACES_ENABLED='0'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS='1'
process.env.ENABLE_QUEUE_WORKERS='false'
const providerAttempts=[]
const deny=(...args)=>{providerAttempts.push({at:new Date().toISOString(),transport:'blocked before network'});throw new Error('LX4 local rehearsal forbids provider access.')}
https.request=deny;https.get=deny
for(const method of ['request','get']){const original=http[method];http[method]=function(url,...args){const host=typeof url==='string'?new URL(url).hostname:url?.hostname??url?.host;if(host&&!['localhost','127.0.0.1','::1'].includes(host))return deny();return original.call(this,url,...args)}}
const originalFetch=globalThis.fetch
globalThis.fetch=(url,options)=>['localhost','127.0.0.1','[::1]'].includes(new URL(typeof url==='string'||url instanceof URL?url:url.url).hostname)?originalFetch(url,options):deny()
syncBuiltinESMExports()
const runtime=await import('./rehearsal-runtime.mjs')
const {prisma,inDatabaseTransaction}=runtime
const rootId='cmokmy3a40078pm0p1fvnu523',childId='cmokmy0lr0009pm0p9yxk7ho0'
const root=await prisma.product.findUniqueOrThrow({where:{id:rootId}})
const child=await prisma.product.findUniqueOrThrow({where:{id:childId}})
assert.equal(root.sku,'GALE-JACKET');assert.equal(child.parentId,rootId);assert.match(child.name,/XAVIA/i)
const writes=JSON.parse(await fs.readFile(new URL('rehearsal-http.json',import.meta.url)).catch(()=>'{"writes":[]}')).writes
const app=Fastify({logger:false})
app.addHook('onRequest',async(req,reply)=>{
 if(req.method==='GET')return
 if(req.method==='POST'&&/^\/api\/pim\/formulas\/(?:batch|preview)$/.test(req.url))return
 if(req.method!=='PATCH'||req.url!=='/api/products/bulk')return reply.code(403).send({error:'Only the fixed XAVIA addressed bulk rehearsal is writable.'})
})
app.addHook('onRoute',route=>{
 if(route.method!=='PATCH'||route.url!=='/api/products/bulk')return
 const handler=route.handler
 route.handler=async function(request,reply){
  const changes=request.body?.changes??[]
  assert.ok(changes.length>0&&changes.every(change=>change.id===childId),'Only the fixed XAVIA child may change.')
  const before=await prisma.outboundSyncQueue.findMany({where:{productId:childId},select:{id:true}})
  const result=await inDatabaseTransaction(prisma,async()=>{
   const response=await handler.call(this,request,reply)
   // This hold commits atomically with the real writer. Existing cron workers can
   // never observe an eligible rehearsal queue row, even while waiting for UI input.
   await prisma.outboundSyncQueue.updateMany({where:{productId:childId,id:{notIn:before.map(row=>row.id)}},data:{holdUntil:new Date('2099-01-01T00:00:00Z')}})
   return response
  })
  writes.push({at:new Date().toISOString(),body:request.body,result})
  await fs.writeFile(new URL('rehearsal-http.json',import.meta.url),JSON.stringify({target:target.identity,writes,providerAttempts},null,2)+'\n')
  return result
 }
})
await app.register(runtime.products,{prefix:'/api'})
await app.register(runtime.studio,{prefix:'/api'})
await app.register(runtime.formulas,{prefix:'/api'})
await app.register(runtime.translations,{prefix:'/api'})
await app.register(runtime.global,{prefix:'/api'})
app.get('/api/fixture/info',async()=>({product:{id:root.id,sku:root.sku,name:root.name,status:root.status,isParent:true,parentId:null,productType:root.productType,asin:root.asin},rootId,childId,
 marketplaces:[{id:'lx-amazon',channel:'AMAZON',code:'DE',name:'Germany',language:'de',languages:['de'],connected:true,accounts:[{id:'cmothu9bo0000nz01asw6wx8j',label:'XAVIA Amazon',primary:true}]},{id:'lx-primary',channel:'AMAZON',code:'IT',name:'Italy',language:'it',languages:['it'],connected:true,accounts:[{id:'cmothu9bo0000nz01asw6wx8j',label:'XAVIA Amazon',primary:true}]}]}))
app.get('/api/fixture/evidence',async()=>({writes,providerAttempts}))
await app.listen({host:'127.0.0.1',port:4119})
console.log(JSON.stringify({ready:true,port:4119,...target.identity,rootId,childId,provider:'blocked',queueHold:'2099, atomically before commit'}))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();await prisma.$disconnect();process.exit(0)})
