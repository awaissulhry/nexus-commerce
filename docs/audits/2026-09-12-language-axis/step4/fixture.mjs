/** Fixed local XAVIA receipt/restore instrument. Not a backfill or catalogue mover. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const [command,phase='control']=process.argv.slice(2)
assert.ok(['snapshot','read','restore','drift'].includes(command))
const target=await databaseTarget('local');assert.equal(target.identity.database,'nexus_development')
const db=new Client({connectionString:target.connectionString});await db.connect()
const id='cmokmy0lr0009pm0p9yxk7ho0',listingId='cmp00tsac0037s101ijg2of6x'
const backupUrl=new URL('fixture-baseline.json',import.meta.url)
async function read(){
 const at=(await db.query('SELECT clock_timestamp() AS at')).rows[0].at
 const data={}
 for(const table of ['Product','ProductTranslation','ChannelListing','ChannelListingTranslation','CellFormula','OutboundSyncQueue']){
  const where=table==='Product'?'id=$1':table==='ChannelListingTranslation'?'"channelListingId" IN (SELECT id FROM "ChannelListing" WHERE "productId"=$1)':'"productId"=$1'
  data[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY id`,[id])).rows.map(x=>x.row)
 }
 return {at,...target.identity,productId:id,data}
}
try{
 if(command==='snapshot'){
  const snapshot=await read();assert.equal(snapshot.data.Product[0].parentId,'cmokmy3a40078pm0p1fvnu523');assert.match(snapshot.data.Product[0].name,/XAVIA/)
  assert.equal(snapshot.data.CellFormula.length,0,'Stop if the fixture has formula writes to restore.')
  await fs.writeFile(backupUrl,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({at:snapshot.at,...target.identity,productId:id,counts:Object.fromEntries(Object.entries(snapshot.data).map(([k,v])=>[k,v.length]))}));
 }else if(command==='read'){
  const current=await read();await fs.writeFile(new URL(`fixture-${phase}.json`,import.meta.url),JSON.stringify(current,null,2)+'\n')
  const baseline=JSON.parse(await fs.readFile(backupUrl))
  const changed=Object.fromEntries(Object.entries(current.data).map(([table,rows])=>[table,rows.filter(row=>JSON.stringify(baseline.data[table].find(b=>b.id===row.id))!==JSON.stringify(row)).map(row=>({id:row.id,version:row.version,language:row.language,name:['Product','ProductTranslation','ChannelListingTranslation'].includes(table)?row.name:undefined,holdUntil:row.holdUntil}))]))
  console.log(JSON.stringify({at:current.at,phase,changed}))
 }else if(command==='drift'){
  const baseline=JSON.parse(await fs.readFile(backupUrl));const old=baseline.data.ChannelListing.find(l=>l.id===listingId)
  await db.query('BEGIN')
  const result=await db.query('UPDATE "ChannelListing" t SET "followMasterTitle"=true,version=version+1 WHERE id=$1 AND to_jsonb(t)=$2::jsonb',[listingId,JSON.stringify(old)])
  assert.equal(result.rowCount,1,'Fixture changed before drift setup; keep its newer value.');await db.query('COMMIT')
  console.log(JSON.stringify({at:new Date().toISOString(),setup:'only followMasterTitle=true, version+1',listingId}))
 }else{
  const baseline=JSON.parse(await fs.readFile(backupUrl)),current=JSON.parse(await fs.readFile(new URL(`fixture-${phase}.json`,import.meta.url)))
  const wire=JSON.parse(await fs.readFile(new URL('rehearsal-http.json',import.meta.url)).catch(()=>'{"writes":[]}'))
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  const fresh=await read();assert.deepEqual(fresh.data,current.data,'Fixture changed after the receipt; refuse to overwrite it.')
  const restored=[]
  for(const table of ['OutboundSyncQueue','CellFormula','ChannelListingTranslation','ProductTranslation','ChannelListing','Product']){
   const prior=new Map(baseline.data[table].map(row=>[row.id,row]))
   for(const row of current.data[table]){
    const old=prior.get(row.id)
    if(JSON.stringify(old)===JSON.stringify(row))continue
    if(!old){
     assert.ok(['ChannelListingTranslation','ProductTranslation','OutboundSyncQueue'].includes(table),'Unexpected new table row')
     if(table==='OutboundSyncQueue')assert.equal(row.payload?.source,'MASTER_CONTENT_CHANGE')
     const deleted=await db.query(`DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::jsonb`,[row.id,JSON.stringify(row)]);assert.equal(deleted.rowCount,1)
     restored.push({table,id:row.id,action:'removed rehearsal-created row'})
    }else{
     const fields=Object.keys(old).filter(key=>key!=='id'&&key!=='workspaceId'&&JSON.stringify(old[key])!==JSON.stringify(row[key]))
     assert.ok(fields.every(key=>/^[A-Za-z][A-Za-z0-9]*$/.test(key)))
     const columns=fields.map(key=>`"${key}"`).join(',')
     const result=await db.query(`UPDATE "${table}" t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)) WHERE id=$2 AND to_jsonb(t)=$3::jsonb`,[JSON.stringify(old),row.id,JSON.stringify(row)]);assert.equal(result.rowCount,1)
     restored.push({table,id:row.id,fields,action:'restored baseline values'})
    }
   }
   assert.ok([...prior.keys()].every(key=>current.data[table].some(row=>row.id===key)),'A baseline row was removed unexpectedly.')
  }
  await db.query('COMMIT')
  const receipt={at:new Date().toISOString(),phase,...target.identity,restored,auditRows:'retained as rehearsal history'}
  await fs.writeFile(new URL(`restore-${phase}.json`,import.meta.url),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt))
 }
}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{await db.end()}
