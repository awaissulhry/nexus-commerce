/**
 * ACR.0.5 — run the migration inside a transaction and ROLL IT BACK.
 * Postgres DDL is transactional, so this proves the SQL applies and shows the row counts
 * it would touch, without persisting anything. Nothing is committed.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const file = resolve(
  new URL('.', import.meta.url).pathname,
  '../../../packages/database/prisma/migrations/20260805d_acr05_profit_unknown_is_null/migration.sql',
)
const sql = readFileSync(file, 'utf8')
const statements = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)

console.log(`\n${statements.length} statements to validate\n`)
try {
  await p.$transaction(async (tx) => {
    for (const s of statements) {
      const n = await tx.$executeRawUnsafe(s)
      console.log(`  OK  ${s.replace(/\s+/g, ' ').slice(0, 96)}${s.length > 96 ? '…' : ''}`)
      if (/^UPDATE/i.test(s)) console.log(`        → ${n} rows`)
    }
    const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT
        (SELECT COUNT(*) FROM "ProductProfitDaily" WHERE "trueProfitCents" IS NULL)::int AS ppd_unknown,
        (SELECT COUNT(*) FROM "ProductProfitDaily" WHERE "trueProfitCents" IS NOT NULL)::int AS ppd_known,
        (SELECT COUNT(*) FROM "Campaign" WHERE "trueProfitCents" IS NULL)::int AS camp_unknown,
        (SELECT COUNT(*) FROM "Campaign" WHERE "trueProfitCents" IS NOT NULL)::int AS camp_known
    `)
    console.log('\n  post-migration state (inside the rolled-back tx):', after[0])
    throw new Error('__ROLLBACK__')
  })
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === '__ROLLBACK__') console.log('\nRolled back. Nothing was changed.\n')
  else { console.error('\nMIGRATION WOULD FAIL:', msg, '\n'); process.exitCode = 1 }
}
await p.$disconnect()
