/** Browser SDK screen harness: real pages and route handlers; isolated fixture identity; local DB read-only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import Fastify from 'fastify'
import { SYSTEM_ROLES } from '@nexus/shared/permissions'
import { databaseTarget } from '../step1/target.mjs'
const target = await databaseTarget('local'); assert.equal(target.identity.database,'nexus_development'); assert.equal(new URL(target.connectionString).port,'55439')
const databaseUrl = new URL(target.connectionString); databaseUrl.searchParams.set('options','-c default_transaction_read_only=on')
Object.assign(process.env,{DATABASE_URL:databaseUrl.href,NEXUS_WORKSPACES_ENABLED:'0',NEXUS_DISABLE_BACKGROUND_JOBS:'1',ENABLE_QUEUE_WORKERS:'false'})
const upstreamRequest = http.request.bind(http), transportAttempts=[], requests=[], refused=[], incomingPaths=[]; globalThis.__lxGateways=[]
const deny = () => { transportAttempts.push(new Date().toISOString()); throw new Error('LX7 provider transport blocked') }
http.get=deny; http.request=deny; https.get=deny; https.request=deny; globalThis.fetch=deny; syncBuiltinESMExports()
const r = await import('./runtime.mjs'), app=Fastify({logger:false})
const userId='lx4_gate_da778dba-6b1b-4912-a05b-dad2ba810e47', rootId='cmokmy3a40078pm0p1fvnu523'
const family=await r.prisma.product.findMany({where:{OR:[{id:rootId},{parentId:rootId}]},select:{id:true,sku:true}});assert.equal(family.length,21)
const identityResponse={user:{id:userId,displayName:'LX7 read-only gate',email:'lx7@example.test',roleKeys:['OPS_MANAGER'],mfaEnabled:false,mfaRequired:false},isOwner:false,permissions:SYSTEM_ROLES.OPS_MANAGER.permissions}
const allowedGet = new Set(['/api/auth/me','/api/auth/csrf','/api/tags',`/api/pim/family/${rootId}`,'/api/categories/reference-labels','/api/marketplaces/grouped','/api/connections','/api/saved-views','/api/products/facets',`/api/products/${rootId}`,'/api/catalog-transfer/options','/api/catalog-transfer/languages','/api/catalog-transfer/readiness/options','/api/catalog-transfer/readiness','/api/catalog-transfer/translate/runs'])
const allowedPost = new Set(['/api/pim/formulas/batch','/api/products/grid','/api/catalog-transfer/translate/preview'])
app.addHook('onRequest',async(req,reply)=>{reply.header('Access-Control-Allow-Origin','http://localhost:4121').header('Access-Control-Allow-Credentials','true').header('Access-Control-Allow-Headers',req.headers['access-control-request-headers']??'content-type,x-nexus-csrf').header('Access-Control-Allow-Methods','GET,POST,OPTIONS');if(req.method==='OPTIONS')return reply.code(204).send();req.authUser={id:userId}; const path=req.url.split('?')[0]; if(!(req.method==='GET'?(allowedGet.has(path)||path.startsWith(`/api/products/${rootId}/studio/`)||path===`/api/products/${rootId}/readiness`||path===`/api/products/${rootId}/sync-queue`||path===`/api/products/${rootId}/global`||path.startsWith('/api/pim/formulas/')||path.startsWith('/api/products/ai/drafts')):req.method==='POST'&&allowedPost.has(path))){refused.push({method:req.method,path});return reply.code(403).send({error:'Read-only LX7 screen harness.'})}})
const resultReceipt=(path,result)=>{
 if(result===undefined)return undefined
 const serialized=JSON.stringify(result)
 if(path.startsWith('/api/catalog-transfer/')||path==='/api/products/grid')return {bytes:Buffer.byteLength(serialized),sha256:createHash('sha256').update(serialized).digest('hex'),value:result}
 return {bytes:Buffer.byteLength(serialized),sha256:createHash('sha256').update(serialized).digest('hex'),keys:result&&typeof result==='object'?Object.keys(result):[],rows:Array.isArray(result?.rows)?result.rows.length:undefined,columns:Array.isArray(result?.columns)?result.columns.length:undefined,schemaAge:result?.meta?.schemaAge}
}
app.addHook('onError',async(req,reply,error)=>{requests.push({at:new Date().toISOString(),method:req.method,path:req.url,status:error.statusCode??500,error:error.message,rolledBack:true})})
app.addHook('onRoute',route=>{const handler=route.handler;route.handler=async function(req,reply){const rollback=new Error('LX7 read-only rollback');let result;try{await r.inDatabaseTransaction(r.prisma,()=>r.withCachedSchemas(async()=>{result=await handler.call(this,req,reply);throw rollback}))}catch(error){if(error!==rollback)throw error}requests.push({at:new Date().toISOString(),method:req.method,path:req.url,...(req.body?{body:req.body}:{}),status:reply.statusCode,result:resultReceipt(req.url,result),rolledBack:true});return result}})
for(const name of ['products','productsCatalog','marketplaces','catalogue','connections','pim','categories','studio','formulas','global','productsAi'])await app.register(r[name],{prefix:'/api'})
app.get('/api/auth/me',async()=>identityResponse);app.get('/api/auth/csrf',async()=>({csrfToken:'lx7-isolated-read-only'}));
await app.listen({host:'127.0.0.1',port:4122})
const evidence=()=>({at:new Date().toISOString(),target:target.identity,readOnly:true,identityAdapter:'Fixed test user in isolated harness; not an authentication gate',family,requests,refused,incomingPaths,transportAttempts,gateways:globalThis.__lxGateways})
const bridge=''
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost:4121');incomingPaths.push({at:new Date().toISOString(),method:req.method,path:req.url});const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
 if(u.pathname==='/gate/evidence')return json(evidence())
 if(u.pathname==='/api/auth/csrf')return json({csrfToken:'lx7-isolated-read-only'})
 if(u.pathname==='/api/auth/me')return json({user:{id:userId,displayName:'LX7 read-only gate',email:'lx7@example.test',roleKeys:['OPS_MANAGER'],mfaEnabled:false,mfaRequired:false},isOwner:false,permissions:SYSTEM_ROLES.OPS_MANAGER.permissions})
 if(u.pathname.startsWith('/api/')){const body=[];for await(const chunk of req)body.push(chunk);const response=await app.inject({method:req.method,url:req.url,headers:{'content-type':req.headers['content-type']??'application/json'},...(body.length?{payload:Buffer.concat(body)}:{})});res.writeHead(response.statusCode,{'content-type':response.headers['content-type']??'application/json'});return res.end(response.rawPayload)}
 if(req.method!=='GET'||u.pathname==='/_next/image'){res.writeHead(404);return res.end()}
 const upstream=upstreamRequest({hostname:'127.0.0.1',port:3000,path:req.url,method:'GET',headers:{...Object.fromEntries(Object.entries(req.headers).filter(([key])=>!['if-none-match','if-modified-since'].includes(key))),host:'localhost:3000','accept-encoding':'identity'}},incoming=>{const chunks=[];incoming.on('data',b=>chunks.push(b));incoming.on('end',()=>{let body=Buffer.concat(chunks);const headers={...incoming.headers};headers['cache-control']='no-store';delete headers.etag;delete headers['last-modified'];delete headers['content-length'];delete headers['content-encoding'];delete headers['transfer-encoding'];delete headers['content-security-policy'];headers['content-security-policy']="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:4122 ws://localhost:4121; frame-src 'self'";if(String(headers['content-type']).includes('javascript'))body=Buffer.from(body.toString().replaceAll('http://localhost:8091','http://localhost:4122').replaceAll('http://127.0.0.1:8091','http://localhost:4122'));if(String(headers['content-type']).includes('text/html'))body=Buffer.from(body.toString().replace('<head>','<head>'+bridge));res.writeHead(incoming.statusCode??500,headers);res.end(body)})});upstream.on('error',error=>{res.writeHead(502);res.end(error.message)});upstream.end()
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}))}})
server.on('upgrade',(req,socket,head)=>{const up=upstreamRequest({hostname:'127.0.0.1',port:3000,path:req.url,headers:{...req.headers,host:'localhost:3000'}});up.on('upgrade',(response,upSocket,upHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(upHead.length)socket.write(upHead);if(head.length)upSocket.write(head);socket.pipe(upSocket).pipe(socket);socket.on('error',()=>upSocket.destroy());upSocket.on('error',()=>socket.destroy())});up.on('error',()=>socket.destroy());up.end()});
server.listen(4121,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:4121,apiPort:4122,target:target.identity,family:family.length,readOnly:true})))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await fs.writeFile(new URL('screen-api-evidence.json',import.meta.url),JSON.stringify(evidence(),null,2));server.close();await app.close();await r.prisma.$disconnect();process.exit(0)})
