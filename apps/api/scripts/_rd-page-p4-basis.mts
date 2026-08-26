// RD-P4 — the contributor BASIS, measured directly (the SQP branch only runs at rest-of-search
// hours, so the service path cannot be exercised on demand). Read-only, no .catch.
import '../src/env.js'
import prisma from '../src/db.js'
import { classifySqpFreshness } from '../src/services/advertising/rank-runtime.js'

async function main() {
  const scheds = await prisma.adSchedule.findMany({ select: { campaignId: true } })
  const campIds = [...new Set(scheds.map((s) => s.campaignId))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true, marketplace: true } })
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: { in: campIds } }, asin: { not: null } },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsByCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const cid = a.adGroup?.campaignId; if (!cid || !a.asin) continue
    const s = asinsByCampaign.get(cid) ?? new Set<string>(); s.add(a.asin); asinsByCampaign.set(cid, s)
  }

  const latestByMarket = new Map<string, { start: Date; asins: Set<string> }>()
  for (const m of [...new Set(camps.map((c) => c.marketplace).filter(Boolean) as string[])]) {
    const newest = await prisma.searchQueryPerformance.findFirst({ where: { marketplace: m }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
    if (!newest) continue
    const rows = await prisma.searchQueryPerformance.groupBy({ by: ['asin'], where: { marketplace: m, startDate: newest.startDate } })
    latestByMarket.set(m, { start: newest.startDate, asins: new Set(rows.map((r) => r.asin).filter(Boolean) as string[]) })
  }
  const now = new Date()
  console.log('=== latest SQP week per market ===')
  for (const [m, v] of latestByMarket) console.log(`  ${m}: week ${v.start.toISOString().slice(0, 10)} · ${v.asins.size} distinct ASINs · ${Math.round((+now - +v.start) / 864e5)}d old`)

  console.log('\n=== per campaign: basis, and what P4 would say ===')
  let thin = 0, fresh = 0, none = 0
  for (const c of camps) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    const wk = c.marketplace ? latestByMarket.get(c.marketplace) : undefined
    if (!asins.length || !wk) { none++; continue }
    const withData = asins.filter((a) => wk.asins.has(a)).length
    const age = Math.round((+now - +wk.start) / 864e5)
    const f = classifySqpFreshness({ withData, total: asins.length, ageDays: age })
    if (f.freshness === 'stale') thin++; else fresh++
    if (thin + fresh <= 10) console.log(`  ${c.name.slice(0, 30).padEnd(30)} basis=${String(withData).padStart(2)}/${String(asins.length).padEnd(2)} age=${age}d → ${f.freshness}${f.thin ? ' (thin)' : ''}${f.stalled ? ' (stalled)' : ''}`)
  }
  console.log(`\n  would read STALE: ${thin} · FRESH: ${fresh} · no basis: ${none}`)
  console.log('  (SQP §18: 20 of 34 campaigns are steered by exactly one ASIN; mean contributes 10%)')
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
