/** SQP.5 — the deployed job's own market decision, exercised rather than assumed. */
import '../src/env.js'
import prisma from '../src/db.js'
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
const candidates = [...new Set(conns.map((c) => c.marketplace))].sort()
const { ourAsinsForMarketplace } = await import('../src/services/advertising/sqp.service.js')
const eligible: string[] = [], skipped: string[] = [], dormant: string[] = []
for (const mkt of candidates) {
  const asins = await ourAsinsForMarketplace(mkt, 10)
  if (!asins.length) { skipped.push(mkt); continue }
  const active = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: mkt }, { region: mkt }] } })
  if (active === 0) { dormant.push(mkt); continue }
  eligible.push(mkt)
}
console.log(`candidates ${candidates.length}: ${candidates.join(',')}`)
console.log(`eligible ${eligible.length}: ${eligible.join(',')}`)
console.log(`dormant  ${dormant.length}: ${dormant.join(',')}   ← 0 ACTIVE listings, self-restoring`)
console.log(`skipped  ${skipped.length}: ${skipped.join(',')}`)
// 🔴 the "was" is eligible+dormant only. `skipped` markets were never requested, so counting them
// as a saving would claim credit for reports that were never sent.
console.log(`\nnightly reports: ${eligible.length * 10} (was ${(eligible.length + dormant.length) * 10}) — skipped markets were never requested`)
await prisma.$disconnect()
