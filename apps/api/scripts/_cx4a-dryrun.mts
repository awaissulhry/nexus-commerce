/**
 * Dry-run CX.4a the way prod applies it: `prisma migrate deploy` hands the WHOLE file
 * to Postgres, so splitting it here would test something prod never does. BEGIN /
 * ROLLBACK around it means prod is untouched.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

// tsx injects .env only when something imports it; this script deliberately does not
// pull in the Prisma client, so load it explicitly. The value is never printed.
process.loadEnvFile('../../.env')

const sql = readFileSync('../../packages/database/prisma/migrations/20260901a_cx4a_inbound_ledger/migration.sql', 'utf8')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await client.connect()
const one = async (q: string) => (await client.query(q)).rows

console.error(`rows before: ${(await one('SELECT COUNT(*)::int AS n FROM "WebhookEvent"'))[0].n}`)
await client.query('BEGIN')
try {
  await client.query(sql)
  console.error('applied once: OK')
  await client.query(sql)
  console.error('applied twice: OK (idempotent)')

  const cols = await one(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_name='WebhookEvent' AND column_name IN
    ('connectionId','status','attempts','nextAttemptAt','signatureOk','verifiedBy','payloadDigest','lastError','archivedAt','archiveUri') ORDER BY 1`)
  console.error(`\ncolumns: ${cols.length}/10`)
  for (const c of cols) console.error(`  ${String(c.column_name).padEnd(14)} ${String(c.data_type).padEnd(25)} null=${c.is_nullable} default=${c.column_default ?? '-'}`)

  console.error('\nbackfill:')
  for (const r of await one(`SELECT "status","verifiedBy","signatureOk", COUNT(*)::int AS n FROM "WebhookEvent" GROUP BY 1,2,3 ORDER BY 4 DESC`))
    console.error(`  status=${String(r.status).padEnd(7)} verifiedBy=${String(r.verifiedBy).padEnd(8)} signatureOk=${r.signatureOk === null ? 'null' : r.signatureOk}  rows=${r.n}`)

  console.error('\nisProcessed vs status must agree:')
  for (const r of await one(`SELECT "isProcessed", "status", COUNT(*)::int AS n FROM "WebhookEvent" GROUP BY 1,2 ORDER BY 3 DESC`))
    console.error(`  isProcessed=${r.isProcessed} status=${r.status} rows=${r.n}`)

  console.error(`\nindexes: ${(await one(`SELECT indexname FROM pg_indexes WHERE tablename='WebhookEvent' AND (indexname LIKE '%status%' OR indexname LIKE '%connectionId%' OR indexname LIKE '%signatureOk%')`)).map((i:any)=>i.indexname).join(', ')}`)
} catch (e: any) {
  console.error('DRY RUN FAILED:', e?.message)
  await client.query('ROLLBACK'); await client.end(); process.exit(1)
}
await client.query('ROLLBACK')
const still = await one(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='WebhookEvent' AND column_name='status'`)
console.error(`\nrolled back; "status" column present on prod: ${still[0].n === 1 ? 'YES (BAD)' : 'no (correct)'}`)
await client.end()
