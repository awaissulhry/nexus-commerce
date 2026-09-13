import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const target=await databaseTarget(process.argv[2]??'local');const db=new Client({connectionString:target.connectionString});await db.connect()
try{await db.query('BEGIN READ ONLY')
const identity=(await db.query("SELECT current_database() AS database,current_setting('transaction_read_only') AS read_only,clock_timestamp() AS at")).rows[0]
const columns=(await db.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ReadinessIndex' ORDER BY ordinal_position")).rows
const indexes=(await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='ReadinessIndex' ORDER BY indexname")).rows
if(target.identity.target==='local')console.log(JSON.stringify({fixtureQueues:(await db.query('SELECT id,"syncStatus","holdUntil","syncType" FROM "OutboundSyncQueue" WHERE "productId"=$1',["cmokmy0lr0009pm0p9yxk7ho0"])).rows}))
const rows=Number((await db.query('SELECT count(*) FROM "ReadinessIndex"')).rows[0].count)
const migration=(await db.query('SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1',['20260912_lx5_readiness_index'])).rows
const triggers=(await db.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND (tgrelid='\"ReadinessIndex\"'::regclass OR tgname='Product_localizedContent_readonly')")).rows
assert.equal(columns.length,18);assert.equal(indexes.length,5);assert.equal(migration.length,1);assert.ok(migration[0].finished_at);assert.equal(triggers.length,0)
await db.query('ROLLBACK');const result={target:target.identity,identity,columns,indexes,rows,migration,triggers,rolledBack:true};await fs.writeFile(new URL(`${target.identity.target}-schema-read.json`,import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,columns:columns.length,indexes:indexes.length}))
}finally{await db.end()}
