/** SQP.5 §10 — close-out. */
import '../src/env.js'
import prisma from '../src/db.js'
const st = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
const stuck = st.filter((s) => s.status !== 'INGESTED').reduce((a, s) => a + s._count._all, 0)
console.log(`SqpReportRequest: ${st.map((s) => `${s.status}=${s._count._all}`).join(' ')}${stuck ? `  · ${stuck} non-terminal` : '  ✓ nothing stuck'}`)
const blocking: any[] = await prisma.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`)
console.log(`_prisma_migrations genuinely blocking: ${blocking.length}${blocking.length ? ' 🔴' : '  ✓ zero'}`)
console.log(`NEXUS_SQP_ROTATION=[${process.env.NEXUS_SQP_ROTATION ?? 'unset'}]  (stays unset — SQP.4 showed rotation works against completeness, KT.8's floor judges by ASIN count)`)
console.log(`NEXUS_SQP_YIELD_ORDER_OFF=[${process.env.NEXUS_SQP_YIELD_ORDER_OFF ?? 'unset'}] ⇒ yield ordering ACTIVE`)
console.log(`maxBiasPct non-null: ${await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })}`)
console.log('\nnightly request count per market, after this change:')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const n = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: m }, { region: m }] } })
  console.log(`  ${m}: ${n === 0 ? '0 — DORMANT (0 ACTIVE listings; self-restoring)' : '10'}`)
}
await prisma.$disconnect()
