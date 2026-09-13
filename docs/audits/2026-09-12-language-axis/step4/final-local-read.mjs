import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {Client} from 'pg'
import {databaseTarget} from '../step1/target.mjs'
const target=await databaseTarget('local'),db=new Client({connectionString:target.connectionString})
const baseline=JSON.parse(await fs.readFile(new URL('fixture-baseline.json',import.meta.url)))
await db.connect()
try{
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 const receipt=(await db.query("SELECT clock_timestamp() AS at,current_database() AS database,current_setting('transaction_read_only') AS read_only")).rows[0]
 const ids=[baseline.productId,...baseline.data.ChannelListing.map(row=>row.id)]
 const audits=(await db.query('SELECT id,"entityType","entityId",action,metadata,"createdAt" FROM "AuditLog" WHERE "entityId"=ANY($1::text[]) AND "createdAt">=$2 ORDER BY "createdAt"',[ids,baseline.at])).rows
 assert.ok(audits.length>0);assert.ok(audits.every(row=>typeof row.metadata?.language==='string'))
 const queue=(await db.query('SELECT id,payload,"holdUntil" FROM "OutboundSyncQueue" WHERE "productId"=$1 AND "createdAt">=$2',[baseline.productId,baseline.at])).rows
 assert.equal(queue.length,0)
 const triggers=(await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows
 assert.equal(triggers.length,0)
 await db.query('ROLLBACK')
 const out={...target.identity,receipt,rolledBack:true,auditCount:audits.length,auditLanguages:audits.reduce((counts,row)=>(counts[row.metadata.language]=(counts[row.metadata.language]??0)+1,counts),{}),audits,remainingRehearsalQueues:queue.length,readonlyTrigger:triggers}
 await fs.writeFile(new URL('final-local-read.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({...out,audits:undefined}))
}finally{await db.end()}
