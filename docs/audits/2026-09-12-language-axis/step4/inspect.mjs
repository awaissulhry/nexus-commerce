import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const [name, phase] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(phase))
const target = await databaseTarget(name)
const db = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 15000, statement_timeout: 30000 })
try {
 await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 const receipt = (await db.query("SELECT transaction_timestamp() AS at, current_setting('transaction_read_only') AS read_only")).rows[0]
 assert.equal(receipt.read_only, 'on')
 const exists = (await db.query(`SELECT to_regclass('"ChannelListingTranslation"') AS table`)).rows[0].table
 assert.equal(!!exists, phase === 'after')
 const rowHashes = {}
 for (const table of ['Product','ProductTranslation','ChannelListing','Marketplace']) rowHashes[table] = (await db.query(`SELECT id, md5(to_jsonb(t)::text) AS hash FROM "${table}" t ORDER BY id`)).rows
 const fixture = (await db.query(`SELECT id,sku,to_jsonb(p)->>'workspaceId' AS "workspaceId",version FROM "Product" p WHERE sku ILIKE 'XAVIA%' ORDER BY sku`)).rows
 const history = (await db.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows
 const guards = (await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows
 assert.equal(guards.length,0)
 const report = {...target.identity,phase,receipt,exists,rowHashes,fixture,history,guards}
 if (phase === 'after') {
  report.count = Number((await db.query('SELECT count(*) FROM "ChannelListingTranslation"')).rows[0].count); assert.equal(report.count,0)
  const before = JSON.parse(await fs.readFile(new URL(`${name}-before.json`, import.meta.url)))
  const folder = '20260912_lx4_channel_listing_translations'
  const checksum = createHash('sha256').update(await fs.readFile(new URL(`../../../../packages/database/prisma/migrations/${folder}/migration.sql`,import.meta.url))).digest('hex')
  assert.ok(history.some(r=>r.migration_name===folder&&r.checksum===checksum&&r.finished_at&&!r.rolled_back_at))
  report.checksum=checksum
  const prior=new Set(before.history.filter(r=>r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name))
  report.newlyApplied=history.filter(r=>r.finished_at&&!r.rolled_back_at&&!prior.has(r.migration_name)).map(r=>r.migration_name); assert.deepEqual(report.newlyApplied,[folder])
  report.existingRowChanges=Object.fromEntries(Object.entries(rowHashes).map(([table,entries])=>{const old=new Map(before.rowHashes[table].map(r=>[r.id,r.hash])),now=new Map(entries.map(r=>[r.id,r.hash]));return [table,{added:[...now.keys()].filter(id=>!old.has(id)),removed:[...old.keys()].filter(id=>!now.has(id)),changed:[...now.keys()].filter(id=>old.has(id)&&old.get(id)!==now.get(id))}]}))
 }
 await db.query('ROLLBACK'); report.rolledBack=true
 await fs.writeFile(new URL(`${name}-${phase}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({...target.identity,phase,receipt,exists,fixture:fixture.slice(0,2),fixtureCount:fixture.length,count:report.count,checksum:report.checksum,newlyApplied:report.newlyApplied,existingRowChanges:report.existingRowChanges}))
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end() }
