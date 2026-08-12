/**
 * HV.2 — the policy table exists and behaves. READ-ONLY (one probe insert is rolled back).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adsHarvestPolicy.findMany()
console.log(`AdsHarvestPolicy rows: ${rows.length}`)
console.log(rows.map(r => `  ${r.scopeGrain}/${r.scopeId}/${r.kind}: ${r.minOrders}o ${r.minClicks}c acos<=${r.maxAcosPct ?? '—'} ${r.windowDays}d exExact=${r.excludeExactMatched} by ${r.updatedBy}`).join('\n') || '  (empty — as expected before anything is saved)')
// 🔴 the constraint that matters: two account rows must be impossible.
try {
  await prisma.$transaction(async (tx) => {
    await tx.adsHarvestPolicy.create({ data: { scopeGrain: 'account', minOrders: 2, minClicks: 3, maxAcosPct: 45, windowDays: 60, updatedBy: 'probe' } })
    await tx.adsHarvestPolicy.create({ data: { scopeGrain: 'account', minOrders: 9, minClicks: 9, maxAcosPct: 9, windowDays: 30, updatedBy: 'probe' } })
    throw new Error('__rollback__')
  })
} catch (e) {
  const m = (e as Error).message
  if (m.includes('__rollback__')) console.log('\n🔴 TWO ACCOUNT ROWS WERE ACCEPTED — the sentinel is not doing its job')
  else if (/[Uu]nique/.test(m)) console.log('\n✅ a second account row is refused by the unique index (sentinel works)')
  else console.log(`\n? unexpected: ${m.slice(0, 160)}`)
}
console.log(`rows after the probe (must still be ${rows.length}): ${await prisma.adsHarvestPolicy.count()}`)
await prisma.$disconnect()
