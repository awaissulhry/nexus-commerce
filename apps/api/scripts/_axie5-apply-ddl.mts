/** AX-IE.5 — apply the additive DDL directly. Idempotent (IF NOT EXISTS), so
 *  Railway's `migrate deploy` will still run and RECORD the migration normally. */
const { default: p } = await import('../src/db.js')
for (const sql of [
  `ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planToken" TEXT`,
  `ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planComputedAt" TIMESTAMP(3)`,
  `ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planSummary" JSONB`,
]) { await p.$executeRawUnsafe(sql); console.log('OK', sql.slice(0, 62)) }
const cols = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT column_name::text c FROM information_schema.columns
    WHERE table_name='ImportJob' AND column_name IN ('planToken','planComputedAt','planSummary') ORDER BY 1`)
console.log('PRESENT', JSON.stringify(cols))
await p.$disconnect()
