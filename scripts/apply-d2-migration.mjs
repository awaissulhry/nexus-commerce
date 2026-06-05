#!/usr/bin/env node
// One-shot: apply the D.2 AmazonReviewInsight migration via pg (Prisma's
// connector P1002-times-out on Neon's direct endpoint; pg connects fine), and
// record it in _prisma_migrations with Prisma's exact sha256 checksum so a
// future `prisma migrate deploy` (Railway prestart) treats it as applied.
// Idempotent: no-ops if already applied.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import crypto from 'crypto'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const NAME = '20260605_d2_amazon_review_insight'
const sqlPath = path.join(here, '..', 'packages', 'database', 'prisma', 'migrations', NAME, 'migration.sql')
const sql = readFileSync(sqlPath, 'utf8')
const checksum = crypto.createHash('sha256').update(sql).digest('hex')

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
const c = new pg.Client({ connectionString: url })
await c.connect()

const already = await c.query(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1`, [NAME])
if (already.rows.length) { console.log(`Already recorded: ${NAME} — nothing to do.`); await c.end(); process.exit(0) }

const tbl = await c.query(`SELECT to_regclass('public."AmazonReviewInsight"') AS t`)
try {
  await c.query('BEGIN')
  if (!tbl.rows[0].t) { await c.query(sql) } else { console.log('Table already exists; recording migration only.') }
  await c.query(
    `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
    [crypto.randomUUID(), checksum, NAME],
  )
  await c.query('COMMIT')
  console.log(`Applied + recorded: ${NAME} (checksum ${checksum.slice(0, 12)}…)`)
} catch (e) {
  await c.query('ROLLBACK')
  console.error('FAILED, rolled back:', e.message)
  process.exit(1)
}

// verify
const v = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='AmazonReviewInsight' ORDER BY ordinal_position`)
console.log('AmazonReviewInsight columns:', v.rows.map((r) => r.column_name).join(', '))
await c.end()
