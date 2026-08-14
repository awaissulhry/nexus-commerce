/** SQP.5 §4.3 — what FR's ten nightly slots actually buy, and what stopping them costs. */
import '../src/env.js'
import prisma from '../src/db.js'

const week = new Date('2026-08-02T00:00:00Z')
console.log('━━━ FR: what the ten slots bought ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const rs = await prisma.sqpReportRequest.findMany({
  where: { marketplace: 'FR', reportPeriod: 'WEEK', startDate: week }, select: { asin: true, rowsParsed: true },
})
console.log(`  ${rs.length} requests → ${rs.filter((r) => (r.rowsParsed ?? 0) > 0).length} produced → ${rs.reduce((s, r) => s + (r.rowsParsed ?? 0), 0)} rows`)
const active = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: 'FR' }, { region: 'FR' }] } })
const byStatus = await prisma.channelListing.groupBy({
  by: ['listingStatus'], where: { channel: 'AMAZON', OR: [{ marketplace: 'FR' }, { region: 'FR' }] }, _count: { _all: true },
})
console.log(`  FR listings: ${byStatus.map((b) => `${b.listingStatus}=${b._count._all}`).join(' ')} · ACTIVE=${active}`)

console.log('\n━━━ FR history: what would be lost by stopping ━━━━━━━━━━━━━━━━━━━━━━━━━━')
const g = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate'], where: { marketplace: 'FR', reportPeriod: 'WEEK' }, _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 8,
})
const asinRows = await prisma.searchQueryPerformance.findMany({
  where: { marketplace: 'FR', reportPeriod: 'WEEK' }, select: { startDate: true, asin: true }, distinct: ['startDate', 'asin'],
})
for (const w of g) {
  const k = w.startDate.toISOString().slice(0, 10)
  const a = asinRows.filter((r) => r.startDate.toISOString().slice(0, 10) === k).length
  console.log(`  ${k}: ${String(w._count._all).padStart(4)} rows · ${a} ASINs`)
}

console.log('\n━━━ the restore trigger: when should FR come back? ━━━━━━━━━━━━━━━━━━━━━━━')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const n = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: m }, { region: m }] } })
  const tot = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: m }, { region: m }] } })
  console.log(`  ${m}: ${n} ACTIVE of ${tot} listings${n === 0 ? '   🔴 zero — the feed cannot measure what is not listed active' : ''}`)
}
console.log('\n  ⇒ a market with 0 ACTIVE listings cannot produce; a trigger on that count going > 0')
console.log('    restores it automatically, and is one query rather than a diary note.')
await prisma.$disconnect()
