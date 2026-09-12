/** Read-only drop receipt; no business writes. */
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const name = process.argv[2]
const target = await databaseTarget(name)
const db = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 15000, statement_timeout: 30000 })
const folder = '20260912_lx1_remove_legacy_content_guard'
try {
 await db.connect()
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 const receipt = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, transaction_timestamp() AS at")).rows[0]
 assert.equal(receipt.read_only, 'on')
 const triggers = (await db.query(`SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='"Product"'::regclass AND tgname='Product_localizedContent_readonly'`)).rows
 const functions = (await db.query("SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='nexus_lx1_legacy_content_readonly'")).rows
 const columns = (await db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ProductTranslation' AND column_name=ANY($1) ORDER BY column_name`, [['attributes','sourceHash','authoredAt','version']])).rows
 const history = (await db.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows
 const sql = await readFile(new URL('../../../../packages/database/prisma/migrations/'+folder+'/migration.sql', import.meta.url))
 const checksum = createHash('sha256').update(sql).digest('hex')
 assert.equal(triggers.length,0); assert.equal(functions.length,0); assert.equal(columns.length,4)
 assert.ok(history.some(r => r.migration_name===folder && r.checksum===checksum && r.finished_at && !r.rolled_back_at))
 const rowHashes = {}
 for (const table of ['Product','ProductTranslation','ChannelListing','Marketplace']) rowHashes[table] = (await db.query(`SELECT id, md5(to_jsonb(t)::text) AS hash FROM "${table}" t ORDER BY id`)).rows
 const family = (await db.query(`SELECT id,sku,"parentId",version FROM "Product" WHERE sku='GALE-JACKET' OR "parentId" IN (SELECT id FROM "Product" WHERE sku='GALE-JACKET') ORDER BY id`)).rows
 const prior = JSON.parse(await readFile(new URL('../step1/'+name+'-after.json', import.meta.url)))
 const previouslyApplied = new Set(prior.history.filter(r=>r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name))
 const newlyApplied = history.filter(r=>r.finished_at&&!r.rolled_back_at&&!previouslyApplied.has(r.migration_name)).map(r=>r.migration_name)
 await db.query('ROLLBACK')
 const result = {...target.identity, receipt, triggers, functions, columns, checksum, newlyApplied, history, rowHashes, family, rolledBack:true,
  publicDomain:name==='production'?process.env.RAILWAY_PUBLIC_DOMAIN:undefined}
 await writeFile(new URL('./'+name+'-receipt.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({...target.identity,receipt,triggers,functions,columns,checksum,newlyApplied,familyRows:family.length,publicDomain:result.publicDomain},null,2))
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end() }
