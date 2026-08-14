/**
 * SQP.4 §6.5 — what the rank engine actually reads, before/after. `sqpImpressionShareForAsins` is
 * IMPORTED and called the way `ad-rank-defend.job.ts` calls it, not reconstructed.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { sqpImpressionShareForAsins } from '../src/services/advertising/sqp.service.js'

const rt = await prisma.rankTarget.findMany({ select: { id: true, name: true, maxBiasPct: true } })
console.log(`RankTarget: ${rt.length} · maxBiasPct non-null: ${rt.filter((r) => r.maxBiasPct !== null).length}`)
console.log(`  ${rt.map((r) => `${r.name}=${r.maxBiasPct ?? 'NULL'}`).join(' · ')}`)
console.log('🔴 a null is NOT neutral — it skips the IS branch and falls through to the ACoS branch, which RAISES.\n')

// campaigns with ads carrying ASINs, grouped the way the engine groups them
const ads = await prisma.adProductAd.findMany({
  where: { asin: { not: null } }, select: { asin: true, adGroupId: true },
})
const groups = await prisma.adGroup.findMany({
  where: { id: { in: [...new Set(ads.map((a) => a.adGroupId))] } }, select: { id: true, campaignId: true },
})
const campOf = new Map(groups.map((g) => [g.id, g.campaignId]))
const camps = await prisma.campaign.findMany({
  where: { id: { in: [...new Set(groups.map((g) => g.campaignId))] } },
  select: { id: true, name: true, marketplace: true },
})
const byCampaign = new Map<string, Set<string>>()
for (const a of ads) {
  const cid = campOf.get(a.adGroupId); if (!cid) continue
  const s = byCampaign.get(cid) ?? new Set(); s.add(a.asin!); byCampaign.set(cid, s)
}

let withSignal = 0, without = 0
const vals: Array<{ c: string; mkt: string; n: number; share: number | null }> = []
for (const c of camps) {
  const asins = [...(byCampaign.get(c.id) ?? [])]
  if (!asins.length || !c.marketplace) continue
  const share = await sqpImpressionShareForAsins(c.marketplace, asins)
  vals.push({ c: c.name.slice(0, 34), mkt: c.marketplace, n: asins.length, share })
  if (share === null) without++; else withSignal++
}
console.log(`campaigns with ASIN-carrying ads: ${vals.length}`)
console.log(`  signal available: ${withSignal}   ·   null (open-loop): ${without}`)
const nonNull = vals.filter((v) => v.share !== null).sort((a, b) => b.share! - a.share!)
console.log(`\n  top by share: ${nonNull.slice(0, 8).map((v) => `${v.mkt}/${v.c}=${(v.share! * 100).toFixed(2)}%`).join(' · ')}`)
console.log(`  by market: ${['IT','DE','ES','FR'].map((m) => `${m} ${vals.filter((v) => v.mkt === m && v.share !== null).length}/${vals.filter((v) => v.mkt === m).length}`).join(' · ')}`)
await prisma.$disconnect()
