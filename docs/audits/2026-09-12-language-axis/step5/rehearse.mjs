import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const phase='after'
const target=await databaseTarget('local');assert.equal(target.identity.database,'nexus_development')
const readOnlyUrl=new URL(target.connectionString);readOnlyUrl.searchParams.set('options','-c default_transaction_read_only=on')
Object.assign(process.env,{DATABASE_URL:target.connectionString,NEXUS_WORKSPACES_ENABLED:'0',NEXUS_DISABLE_BACKGROUND_JOBS:'1',ENABLE_QUEUE_WORKERS:'false'})
const transportAttempts=[];globalThis.__lxBlockedGateways=[]
const deny=()=>{transportAttempts.push(new Date().toISOString());throw new Error('External transport refused by readiness harness')}
https.request=deny;https.get=deny;http.request=deny;http.get=deny;globalThis.fetch=deny;syncBuiltinESMExports()
const runtime=await import(`./rehearsal-runtime-${phase}.mjs`)
const {prisma,inDatabaseTransaction}=runtime
const rootId='cmokmy3a40078pm0p1fvnu523',childId='cmokmy0lr0009pm0p9yxk7ho0'
const db=new Client({connectionString:target.connectionString});await db.connect()
const here=new URL('.',import.meta.url),ledger=new URL('../../../pes-claims.md',import.meta.url)
const tables=['Product','ProductTranslation','ChannelListing','ChannelListingTranslation','CellFormula','OutboundSyncQueue','ReadinessIndex']
async function read(){const data={};for(const table of tables){
 const where=table==='ReadinessIndex'?'"productId" IN (SELECT id FROM "Product" WHERE id=$1 OR "parentId"=$1)':table==='Product'?'id=$1':table==='ChannelListingTranslation'?'"channelListingId" IN (SELECT id FROM "ChannelListing" WHERE "productId"=$1)':'"productId"=$1'
 data[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY id`,[table==='ReadinessIndex'?rootId:childId])).rows.map(r=>r.row)
}return {at:new Date().toISOString(),data}}
const before=await read();assert.equal(before.data.Product[0].parentId,rootId);assert.match(before.data.Product.find(p=>p.id===childId)?.name,/XAVIA/)
assert.ok(before.data.OutboundSyncQueue.every(row=>['FAILED','COMPLETED','SYNCED','CANCELLED'].includes(row.syncStatus)),'Existing pending fixture queue prevents a content rehearsal');assert.ok(before.data.ReadinessIndex.length)
await fs.writeFile(new URL('write-baseline.json',here),JSON.stringify(before,null,2)+'\n',{flag:'wx'})
const announce=message=>fs.appendFile(ledger,`\nLX Step 5 local XAVIA write rehearsal · ${new Date().toISOString()} · ${message}\n`)
let after
try {
 await announce('BEFORE: fixed child German title positive control through writeContent; index must change before commit. Provider transport blocked; any created outbound rows held until 2099 atomically. Read after at least 8 seconds, then restore all changed values and re-read.')
 const product=before.data.Product.find(p=>p.id===childId),translation=before.data.ProductTranslation.find(p=>p.productId===childId&&p.language==='de')
 const started=Date.now()
 await inDatabaseTransaction(prisma,async()=>{
  await runtime.writeContent({productId:childId,address:{tier:'language',language:'de'},values:{title:'XAVIA Bereitschaftsprüfung'},label:'Product title',expectedVersion:product.version,expectedContentVersion:translation?.version??0})
  await prisma.outboundSyncQueue.updateMany({where:{productId:childId,id:{notIn:before.data.OutboundSyncQueue.map(row=>row.id)}},data:{holdUntil:new Date('2099-01-01T00:00:00Z')}})
 })
 const committed=Date.now();await new Promise(resolve=>setTimeout(resolve,8100));after=await read()
 const current=after.data.Product.find(p=>p.id===childId),saved=after.data.ProductTranslation.find(p=>p.productId===childId&&p.language==='de')
 const priorIndex=before.data.ReadinessIndex.find(p=>p.productId===childId&&p.channel===null&&p.language==='de')
 const nextIndex=after.data.ReadinessIndex.find(p=>p.productId===childId&&p.channel===null&&p.language==='de')
 assert.equal(current.version,product.version+1);assert.equal(saved.version,(translation?.version??0)+1);assert.equal(saved.name,'XAVIA Bereitschaftsprüfung');assert.ok(saved.reviewedAt)
 assert.equal(priorIndex.requiredFilled,0);assert.equal(nextIndex.requiredFilled,1);assert.equal(nextIndex.pct,100)
 assert.equal(globalThis.__lxBlockedGateways.length,0);assert.equal(transportAttempts.length,0)
 const receipt={at:after.at,target:target.identity,writeMs:committed-started,delayedReadMs:Date.now()-committed,productVersion:[product.version,current.version],translationVersion:[translation?.version??0,saved.version],index:{before:priorIndex,after:nextIndex},providerGatewaysBlocked:globalThis.__lxBlockedGateways,transportAttempts}
 await fs.writeFile(new URL('write-receipt.json',here),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({positiveControl:true,writeMs:receipt.writeMs,delayedReadMs:receipt.delayedReadMs,productVersion:receipt.productVersion,translationVersion:receipt.translationVersion,requiredFilled:[0,1],providerAttempts:0}))
} finally {
 after=await read();await fs.writeFile(new URL('write-after.json',here),JSON.stringify(after,null,2)+'\n')
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
 try {
  assert.deepEqual((await read()).data,after.data,'Concurrent fixture edit: refuse to restore over it')
  const restored=[]
  for(const table of [...tables].reverse()){
   const old=new Map(before.data[table].map(row=>[row.id,row]))
   for(const row of after.data[table]){
    const prior=old.get(row.id);if(JSON.stringify(prior)===JSON.stringify(row))continue
    if(!prior){const r=await db.query(`DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::jsonb`,[row.id,JSON.stringify(row)]);assert.equal(r.rowCount,1);restored.push({table,id:row.id,action:'remove fixture-created row'})}
    else{const fields=Object.keys(prior).filter(k=>k!=='id'&&k!=='workspaceId'&&JSON.stringify(prior[k])!==JSON.stringify(row[k]));assert.ok(fields.every(k=>/^[A-Za-z][A-Za-z0-9]*$/.test(k)));const columns=fields.map(k=>`"${k}"`).join(',');const r=await db.query(`UPDATE "${table}" t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)) WHERE id=$2 AND to_jsonb(t)=$3::jsonb`,[JSON.stringify(prior),row.id,JSON.stringify(row)]);assert.equal(r.rowCount,1);restored.push({table,id:row.id,fields})}
   }
   for(const prior of before.data[table].filter(row=>!after.data[table].some(r=>r.id===row.id))){assert.equal(table,'ReadinessIndex');await db.query(`INSERT INTO "ReadinessIndex" SELECT * FROM jsonb_populate_record(NULL::"ReadinessIndex",$1::jsonb)`,[JSON.stringify(prior)])}
  }
  await db.query('COMMIT');const restoredAt=Date.now();await new Promise(resolve=>setTimeout(resolve,8100));const final=await read();assert.deepEqual(final.data,before.data)
  const receipt={at:final.at,delayedReadMs:Date.now()-restoredAt,restoredByValue:true,tables:tables.map(table=>({table,rows:final.data[table].length,equal:true})),audit:'Retained rehearsal history',providerGatewaysBlocked:globalThis.__lxBlockedGateways,transportAttempts}
  await fs.writeFile(new URL('write-restored.json',here),JSON.stringify(receipt,null,2)+'\n');await announce(`AFTER: restored by value and re-read after ${receipt.delayedReadMs} ms; all seven table snapshots equal, index included. Audit retained. Provider attempts ${transportAttempts.length}.`);console.log(JSON.stringify(receipt))
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}
 finally{await db.end();await prisma.$disconnect()}
}
