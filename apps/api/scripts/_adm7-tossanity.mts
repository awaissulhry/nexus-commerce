/** ADM.7 — what the Top of Search column will show, using the same weighting as the route. */
import prisma from '../src/db.js'
import { weightedIS } from '../src/services/advertising/placement-grid.service.js'
const since = new Date('2026-08-20'), until = new Date('2026-08-26')
const camps = await prisma.campaign.findMany({ where: { externalCampaignId: { not: null } }, select: { name: true, externalCampaignId: true, adProduct: true } })
const ext = camps.map(c => c.externalCampaignId!) 
const rows = await prisma.amazonAdsPlacementReport.findMany({
  where: { campaignId: { in: ext }, date: { gte: since, lte: until }, topOfSearchIS: { not: null } },
  select: { campaignId: true, impressions: true, topOfSearchIS: true },
})
const by = new Map<string, Array<{value:number;weight:number}>>()
for (const r of rows) { const a = by.get(r.campaignId) ?? []; a.push({ value: Number(r.topOfSearchIS), weight: r.impressions ?? 0 }); by.set(r.campaignId, a) }
let withVal = 0
console.log('campaign                                 ToS IS    days')
for (const c of camps) {
  const p = by.get(c.externalCampaignId!)
  if (!p?.length) continue
  withVal++
  if (withVal <= 12) console.log(`  ${String(c.name).slice(0,38).padEnd(38)} ${((weightedIS(p) ?? 0)*100).toFixed(2).padStart(6)}%  ${String(p.length).padStart(3)}d`)
}
console.log(`\ncampaigns that will now show a value: ${withVal} of ${camps.length}`)
console.log(`placement rows in window with IS: ${rows.length}`)
const bad = [...by.values()].flat().filter(p => p.value < 0 || p.value > 1).length
console.log(`values outside 0..1 (would render as a broken %): ${bad}`)
await prisma.$disconnect()
