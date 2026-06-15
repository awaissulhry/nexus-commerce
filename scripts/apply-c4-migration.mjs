#!/usr/bin/env node
// One-shot: apply the C4 structured CE/PPE migration via pg + record it in
// _prisma_migrations (so Railway prestart `migrate deploy` treats it as applied).
// Idempotent: ADD COLUMN IF NOT EXISTS, recording no-ops if present.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import crypto from 'crypto'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const NAME = '20260615_c4_ce_ppe_structured'
const sqlPath = path.join(here, '..', 'packages', 'database', 'prisma', 'migrations', NAME, 'migration.sql')
const sql = readFileSync(sqlPath, 'utf8')
const checksum = crypto.createHash('sha256').update(sql).digest('hex')

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
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
  } else { console.log(`Columns ensured; ${NAME} already recorded.`) }
  await c.query('COMMIT')
} catch (e) { await c.query('ROLLBACK'); console.error('FAILED, rolled back:', e.message); process.exit(1) }

const v = await c.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='Product'
     AND column_name IN ('garmentClass','notifiedBodyNumber','notifiedBodyName','declarationOfConformityUrl','impactProtectors')
   ORDER BY column_name`,
)
console.log('C4 columns present:', v.rows.map((r) => r.column_name).join(', ') || '(none!)')
await c.end()
