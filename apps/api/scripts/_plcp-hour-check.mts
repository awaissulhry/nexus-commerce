/** Is the "0 rows move" result the rank engine's clock, or a real regression? Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const now = new Date()
console.log(`now: ${now.toISOString()} (Rome ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })})`)
const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, dynamicBidding: true } })
type PB = { placementBidding?: Array<{ placement: string; percentage: number }> }
const lane = (c: typeof enabled[number], l: string) => (((c.dynamicBidding as PB | null)?.placementBidding) ?? []).find((x) => x.placement === l)?.percentage ?? 0
for (const l of ['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE']) {
  const nz = enabled.filter((c) => lane(c, l) > 0)
  console.log(`  ${l}: non-zero on ${nz.length} of ${enabled.length} enabled`)
}
const d1 = new Date(Date.now() - 24 * 36e5)
const rows = await prisma.campaignBidHistory.findMany({
  where: { changedAt: { gte: d1 }, field: 'PLACEMENT_REST_OF_SEARCH', changedBy: { startsWith: 'automation:' } },
  orderBy: { changedAt: 'desc' }, take: 6,
  select: { oldValue: true, newValue: true, changedAt: true, reason: true },
})
console.log(`\nlast 6 automation writes to Rest of Search in 24h:`)
for (const r of rows) console.log(`  ${r.changedAt.toISOString()} ${r.oldValue}→${r.newValue} · ${r.reason?.slice(0, 70)}`)
await prisma.$disconnect()
