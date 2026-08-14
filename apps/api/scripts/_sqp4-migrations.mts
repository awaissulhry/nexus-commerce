/** SQP.4 — the exact state of every non-clean migration row. Read-only. */
import prisma from '../src/db.js'
const rows: any[] = await prisma.$queryRawUnsafe(`
  SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count,
         left(coalesce(logs,''), 220) AS logs
  FROM _prisma_migrations
  WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
  ORDER BY started_at DESC`)
for (const r of rows) {
  console.log(`── ${r.migration_name}`)
  console.log(`   started    ${r.started_at?.toISOString?.() ?? r.started_at}`)
  console.log(`   finished   ${r.finished_at?.toISOString?.() ?? r.finished_at ?? 'NULL'}`)
  console.log(`   rolledBack ${r.rolled_back_at?.toISOString?.() ?? r.rolled_back_at ?? 'NULL'}`)
  console.log(`   steps      ${r.applied_steps_count}`)
  if (r.logs) console.log(`   logs       ${r.logs.replace(/\n/g, ' | ')}`)
}
const tot: any[] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM _prisma_migrations`)
console.log(`\ntotal migration rows: ${tot[0].n}`)
// does the column the "unfinished" one was supposed to add actually exist?
const col: any[] = await prisma.$queryRawUnsafe(
  `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='SqpReportRequest' AND column_name='rowsChanged'`)
console.log(`SqpReportRequest.rowsChanged: ${col.length ? JSON.stringify(col[0]) : 'MISSING'}`)
await prisma.$disconnect()
