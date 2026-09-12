/** LX.2 read-only before/after migration receipts; no provider calls. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const [name, phase] = process.argv.slice(2)
assert.ok(['before','after'].includes(phase))
const target = await databaseTarget(name)
const db = new Client({connectionString:target.connectionString,connectionTimeoutMillis:15000,statement_timeout:30000})
try {
 await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 const receipt=(await db.query("SELECT transaction_timestamp() AS at,current_setting('transaction_read_only') AS read_only")).rows[0]
 assert.equal(receipt.read_only,'on')
 const rows=(await db.query('SELECT to_jsonb(m) AS value FROM "Marketplace" m ORDER BY channel,code')).rows.map(r=>r.value)
 assert.ok(rows.length>0)
 const rowHashes={}
 for (const table of ['Product','ProductTranslation','ChannelListing','Marketplace']) rowHashes[table]=(await db.query(`SELECT id,md5((to_jsonb(t)-$1::text[])::text) AS hash FROM "${table}" t ORDER BY id`,[table==='Marketplace'?['languages']:[]])).rows
 const history=(await db.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows
 const columns=(await db.query(`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='Marketplace' AND column_name=ANY($1) ORDER BY column_name`,[['language','languages']])).rows
 const guards=(await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows
 const report={...target.identity,phase,receipt,markets:rows.map(r=>({id:r.id,channel:r.channel,code:r.code,language:r.language,languages:r.languages})),rowHashes,history,columns,guards}
 if(phase==='before') {
  assert.equal(columns.length,1,'Unexpected existing languages column; review before DDL.')
  assert.ok(rows.filter(r=>r.code==='BE').every(r=>r.language.toLowerCase()==='nl'),'Belgium scalar differs from requested first language; review before DDL.')
 } else {
  const before=JSON.parse(await readFile(new URL('./'+name+'-before.json',import.meta.url)))
  assert.equal(columns.length,2)
  for(const row of rows) assert.deepEqual(row.languages,row.code==='BE'?['nl','fr']:[row.language.toLowerCase()])
  const folder='20260912_lx2_marketplace_languages'
  const checksum=createHash('sha256').update(await readFile(new URL('../../../../packages/database/prisma/migrations/'+folder+'/migration.sql',import.meta.url))).digest('hex')
  assert.ok(history.some(r=>r.migration_name===folder&&r.checksum===checksum&&r.finished_at&&!r.rolled_back_at))
  report.checksum=checksum
  const prior=new Set(before.history.filter(r=>r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name))
  report.newlyApplied=history.filter(r=>r.finished_at&&!r.rolled_back_at&&!prior.has(r.migration_name)).map(r=>r.migration_name)
  assert.deepEqual(report.newlyApplied,[folder])
  report.existingRowChanges=Object.fromEntries(Object.entries(rowHashes).map(([table,entries])=>{const old=new Map(before.rowHashes[table].map(r=>[r.id,r.hash])),now=new Map(entries.map(r=>[r.id,r.hash]));return [table,{added:[...now.keys()].filter(id=>!old.has(id)),removed:[...old.keys()].filter(id=>!now.has(id)),changed:[...now.keys()].filter(id=>old.has(id)&&old.get(id)!==now.get(id))}]}))
  assert.deepEqual(rowHashes.Marketplace,before.rowHashes.Marketplace,'Pre-existing marketplace columns changed.')
 }
 await db.query('ROLLBACK');report.rolledBack=true
 await writeFile(new URL('./'+name+'-'+phase+'.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({...target.identity,phase,receipt,markets:report.markets,columns,newlyApplied:report.newlyApplied,existingRowChanges:report.existingRowChanges},null,2))
} finally {await db.query('ROLLBACK').catch(()=>{});await db.end()}
