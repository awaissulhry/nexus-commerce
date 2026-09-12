// PES.6 — apply ONLY the CategoryChannelMapping migration.
// Deliberately not `prisma migrate deploy`: that would drag PES.5's parked
// listing-alias migration and PES.8's draft migration along with it
// (reference_migrate_deploy_drags_parked_migrations).
import { readFileSync } from 'node:fs'
import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname })

const NAME = '20260902b_pes6_wave4_cellformula_no_lastvalue'
const ROOT = new URL('../../../', import.meta.url).pathname
const sql = readFileSync(`${ROOT}packages/database/prisma/migrations/${NAME}/migration.sql`, 'utf8')

// Neon: DDL must go over the DIRECT (non-pooled) endpoint (reference_neon_migrations).
const raw = process.env.DATABASE_URL ?? ''
if (!raw) { console.error('no DATABASE_URL'); process.exit(1) }
const url = raw.replace('-pooler', '')
console.log('host:', new URL(url).host)

const client = new pg.Client({ connectionString: url })
await client.connect()

const before = await client.query(
  `select to_regclass('"CategoryChannelMapping"') as t`)
console.log('table before:', before.rows[0].t)

await client.query(sql)

const after = await client.query(`
  select column_name, data_type, column_default, is_nullable
  from information_schema.columns
  where table_name = 'CategoryChannelMapping' order by ordinal_position`)
console.log('columns after:', after.rows.length)
for (const r of after.rows) console.log(' ', r.column_name, r.data_type, r.is_nullable === 'YES' ? 'NULL' : 'NOT NULL')

const idx = await client.query(
  `select indexname from pg_indexes where tablename='CategoryChannelMapping' order by indexname`)
console.log('indexes:', idx.rows.map((r: any) => r.indexname).join(', '))

// Record it so a later `migrate deploy` does not try to re-run it.
const already = await client.query(
  `select 1 from "_prisma_migrations" where migration_name = $1`, [NAME])
if (already.rowCount === 0) {
  await client.query(
    `insert into "_prisma_migrations"
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     values (gen_random_uuid()::text, $1, now(), $2, null, null, now(), 1)`,
    [ (await import('node:crypto')).createHash('sha256').update(sql).digest('hex'), NAME ])
  console.log('recorded in _prisma_migrations')
} else {
  console.log('already recorded in _prisma_migrations')
}

await client.end()
