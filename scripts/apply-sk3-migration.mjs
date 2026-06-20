#!/usr/bin/env node
// One-shot: apply the SK3 KeywordRank table migration via pg + record it in _prisma_migrations
// (so Railway prestart `migrate deploy` treats it as applied). Idempotent: CREATE ... IF NOT EXISTS;
// recording no-ops if present. Additive only. Forces the root .env (Neon) URL + strips -pooler.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import crypto from 'crypto'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env'), override: true })

const NAME = '20260620_sk3_keyword_rank'
const sqlPath = path.join(here, '..', 'packages', 'database', 'prisma', 'migrations', NAME, 'migration.sql')
const sql = readFileSync(sqlPath, 'utf8')
const checksum = crypto.createHash('sha256').update(sql).digest('hex')

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const host = new URL(url).host
if (/localhost|127\.0\.0\.1/.test(host)) { console.error(`Refusing: DATABASE_URL host is ${host} (not Neon)`); process.exit(1) }
console.log('Target host:', host)
const c = new pg.Client({ connectionString: url })
await c.connect()
try {
  await c.query('BEGIN')
  await c.query(sql)
  const already = await c.query(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1`, [NAME])
  if (!already.rows.length) {
    await c.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
      [crypto.randomUUID(), checksum, NAME],
    )
    console.log(`Applied + recorded: ${NAME} (checksum ${checksum.slice(0, 12)}…)`)
  } else { console.log(`Table ensured; ${NAME} already recorded.`) }
  await c.query('COMMIT')
} catch (e) { await c.query('ROLLBACK'); console.error('FAILED, rolled back:', e.message); process.exit(1) }

const v = await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='KeywordRank' ORDER BY ordinal_position`,
)
console.log('KeywordRank columns:', v.rows.map((r) => r.column_name).join(', ') || '(none!)')
await c.end()
