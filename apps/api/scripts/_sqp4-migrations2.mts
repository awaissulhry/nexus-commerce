/**
 * SQP.4 — is a rolled-back row actually BLOCKING, or is it the historical record of a failure that
 * was then resolved? `finished_at IS NULL` alone cannot tell those apart.
 */
import prisma from '../src/db.js'
for (const name of ['20260813a_sqp3_rows_changed', '20260505_b1_fulfillment_spine']) {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, started_at, finished_at, rolled_back_at, applied_steps_count
     FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`, name)
  console.log(`── ${name}: ${rows.length} row(s)`)
  for (const r of rows) {
    const state = r.finished_at ? 'APPLIED ✓' : r.rolled_back_at ? 'rolled back (resolved, not blocking)' : '🔴 UNFINISHED — BLOCKS DEPLOYS'
    console.log(`   ${r.started_at.toISOString().slice(0, 19)}  finished=${r.finished_at ? r.finished_at.toISOString().slice(0,19) : 'NULL'}  rolledBack=${r.rolled_back_at ? 'yes' : 'no'}  → ${state}`)
  }
}
// the only shape that actually blocks: failed AND not rolled back
const blocking: any[] = await prisma.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`)
console.log(`\n🔴 genuinely blocking rows (finished_at NULL *and* rolled_back_at NULL): ${blocking.length}${blocking.length ? ' — ' + blocking.map((b) => b.migration_name).join(', ') : '  ✓ none'}`)
const col: any[] = await prisma.$queryRawUnsafe(
  `SELECT column_name::text AS c, data_type::text AS t FROM information_schema.columns WHERE table_name='SqpReportRequest' AND column_name='rowsChanged'`)
console.log(`SqpReportRequest.rowsChanged: ${col.length ? `${col[0].c} ${col[0].t} ✓ present` : '🔴 MISSING'}`)
await prisma.$disconnect()
