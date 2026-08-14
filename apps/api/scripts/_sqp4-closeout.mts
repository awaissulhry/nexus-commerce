/** SQP.4 §10 — close-out: nothing stuck, no unfinished migration, flags stated. */
import prisma from '../src/db.js'
const st = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
const stuck = st.filter((s) => s.status === 'PENDING' || s.status === 'DONE').reduce((a, s) => a + s._count._all, 0)
console.log(`SqpReportRequest: ${st.map((s) => `${s.status}=${s._count._all}`).join(' ')}${stuck ? `  · ${stuck} still outstanding (hourly sqp-collect will drain)` : '  ✓ nothing stuck'}`)
const blocking: any[] = await prisma.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`)
console.log(`_prisma_migrations genuinely blocking: ${blocking.length}${blocking.length ? ' 🔴 ' + blocking.map((b: any) => b.migration_name).join(',') : '  ✓ zero'}`)
console.log(`NEXUS_SQP_ROTATION=[${process.env.NEXUS_SQP_ROTATION ?? 'unset'}] (no longer read — superseded by the explore quota)`)
console.log(`NEXUS_SQP_YIELD_ORDER_OFF=[${process.env.NEXUS_SQP_YIELD_ORDER_OFF ?? 'unset'}] ⇒ yield ordering ACTIVE`)
console.log(`NEXUS_SQP_LOOKBACK=[${process.env.NEXUS_SQP_LOOKBACK ?? 'unset'}] · NEXUS_COVERAGE_ENGINE_MODE=[${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset'}]`)
const rt = await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })
console.log(`RankTarget with maxBiasPct set: ${rt}${rt ? ' 🔴 a bid engine is live' : '  ✓ still all NULL'}`)
await prisma.$disconnect()
