import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import Fastify from 'fastify'
import { databaseTarget } from '../step1/target.mjs'
const commit=process.argv[2]==='commit';assert.ok(!process.argv[2]||commit);const phase='after'
const target=await databaseTarget('local');assert.equal(target.identity.database,'nexus_development')
const readOnlyUrl=new URL(target.connectionString);readOnlyUrl.searchParams.set('options','-c default_transaction_read_only=on')
Object.assign(process.env,{DATABASE_URL:target.connectionString,NEXUS_WORKSPACES_ENABLED:'0',NEXUS_DISABLE_BACKGROUND_JOBS:'1',ENABLE_QUEUE_WORKERS:'false'})
const transportAttempts=[];globalThis.__lxBlockedGateways=[]
const deny=()=>{transportAttempts.push(new Date().toISOString());throw new Error('External transport refused by readiness harness')}
https.request=deny;https.get=deny;http.request=deny;http.get=deny;globalThis.fetch=deny;syncBuiltinESMExports()
const runtime=await import(`./rehearsal-runtime-${phase}.mjs`)
const {prisma,inDatabaseTransaction}=runtime
const rootId='cmokmy3a40078pm0p1fvnu523'
const sentinel=new Error('producer verification rollback');let result
try {
 if(commit)await fs.appendFile(new URL('../../../pes-claims.md',import.meta.url),`\nLX Step 5 LOCAL fixture index production BEFORE · ${new Date().toISOString()} · XAVIA only; populate new derived readiness rows from existing values, no content edits, all provider transport blocked.\n`)
 try { await inDatabaseTransaction(prisma,async()=>{
  const start=performance.now();const count=await runtime.reconcileFamilyReadiness(rootId)
  const rows=await prisma.readinessIndex.findMany({where:{product:{OR:[{id:rootId},{parentId:rootId}]}},select:{channel:true,market:true,language:true,state:true,pct:true,note:true}})
  result={at:new Date().toISOString(),target:target.identity,ms:performance.now()-start,count,rows,providerGatewaysBlocked:globalThis.__lxBlockedGateways,transportAttempts,rolledBack:!commit}
  if(!commit)throw sentinel
 }) } catch(e){if(e!==sentinel)throw e}
 await fs.writeFile(new URL(commit?'producer-local-committed.json':'producer-rollback.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
 if(commit)await fs.appendFile(new URL('../../../pes-claims.md',import.meta.url),`\nLX Step 5 LOCAL fixture index production AFTER · ${new Date().toISOString()} · ${result.count} derived rows; provider gateway/transport attempts ${result.providerGatewaysBlocked.length}/${result.transportAttempts.length}.\n`)
 console.log(JSON.stringify({...result,rows:[...new Map(result.rows.map(r=>[JSON.stringify(r),r])).values()]}))
} finally {await prisma.$disconnect()}
