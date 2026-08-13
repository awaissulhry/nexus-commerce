/** SQP.3 — additive migration: SqpReportRequest.rowsChanged. Idempotent, nothing altered or dropped. */
import { Client } from 'pg'
const u = (process.env.DATABASE_URL || '').replace('-pooler', '')
const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query(`ALTER TABLE "SqpReportRequest" ADD COLUMN IF NOT EXISTS "rowsChanged" INTEGER`)
const r = await c.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='SqpReportRequest' AND column_name='rowsChanged'`)
console.log('COLUMN:', JSON.stringify(r.rows))
const n = await c.query(`SELECT count(*)::int AS total, count("rowsChanged")::int AS filled FROM "SqpReportRequest"`)
console.log('ROWS:', JSON.stringify(n.rows[0]))
await c.end()
