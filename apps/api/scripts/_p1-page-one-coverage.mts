/**
 * P1 — "can all three of my jackets be on page one at once?" — measured, not argued.
 * READ-ONLY: no writes, no mutations.
 *
 * The operator's hypothesis (2026-08-10): similar products are DIFFERENT ASINs with different
 * SKUs, so several of them should be able to occupy the same results page — the first row where
 * it matters, and the rest of the search page for breadth — rather than one winning and the
 * others being suppressed.
 *
 * That is testable against data already in this database. Three questions:
 *
 *   1. **Is it already happening?** For each search query we pay for, how many DISTINCT
 *      campaigns and ASINs of ours actually took impressions on it? If the answer is routinely
 *      >1, multi-ASIN coverage is not a thing to build — it is a thing to steer.
 *   2. **Where is our volume today?** The placement split (Top of Search / Other on-Amazon /
 *      Detail Page), because "rest of search" is where breadth is cheap and top-of-search is
 *      where the slots are scarce.
 *   3. **How much of top-of-search do we actually hold?** `topOfSearchIS` is Amazon's own
 *      impression share, stored on the TOP row — the honest ceiling on "we own this term".
 *
 * NOTE on vocabulary: `AmazonAdsPlacementReport.placement` holds Amazon's REPORT labels
 * ('Top of Search on-Amazon', 'Other on-Amazon', 'Detail Page on-Amazon'), NOT the API enums
 * the write path uses. Matching on the enum names here would return nothing.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const DAYS = 60
const since = new Date(Date.now() - DAYS * 86_400_000)
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log(`\n═══ P1 — page-one coverage, last ${DAYS} days ═══\n`)

// ── 2. where our volume sits ──────────────────────────────────────────────────
const byPlacement = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['placement'],
  where: { date: { gte: since } },
  _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true },
})
const totImpr = byPlacement.reduce((a, p) => a + (p._sum.impressions ?? 0), 0)
console.log('── where our impressions actually land ──')
for (const p of [...byPlacement].sort((a, b) => (b._sum.impressions ?? 0) - (a._sum.impressions ?? 0))) {
  const im = p._sum.impressions ?? 0
  const spend = Number(p._sum.costMicros ?? 0n) / 1e6
  const sales = (p._sum.sales7dCents ?? 0) / 100
  console.log(`  ${pad(p.placement, 26)} ${String(int(im)).padStart(10)} impr  ${(totImpr ? (im / totImpr) * 100 : 0).toFixed(1).padStart(5)}%   €${spend.toFixed(2).padStart(9)} spend   €${sales.toFixed(2).padStart(9)} sales`)
}

// ── 3. how much of top-of-search we hold ──────────────────────────────────────
const tosRows = await prisma.amazonAdsPlacementReport.findMany({
  where: { date: { gte: since }, topOfSearchIS: { not: null } },
  select: { campaignId: true, topOfSearchIS: true, impressions: true },
})
if (tosRows.length) {
  const vals = tosRows.map((r) => Number(r.topOfSearchIS)).filter((v) => Number.isFinite(v))
  const weighted = tosRows.reduce((a, r) => a + Number(r.topOfSearchIS) * r.impressions, 0) / Math.max(1, tosRows.reduce((a, r) => a + r.impressions, 0))
  vals.sort((a, b) => a - b)
  console.log(`\n── top-of-search impression share (Amazon's own figure, ${int(tosRows.length)} campaign-days) ──`)
  console.log(`  impression-weighted mean : ${(weighted * 100).toFixed(1)}%`)
  console.log(`  median                   : ${((vals[Math.floor(vals.length / 2)] ?? 0) * 100).toFixed(1)}%`)
  console.log(`  best campaign-day        : ${((vals[vals.length - 1] ?? 0) * 100).toFixed(1)}%`)
  console.log(`  → the headroom on "own the first row" is whatever this is short of 100%.`)
} else {
  console.log(`\n── top-of-search impression share: NO rows carry topOfSearchIS in this window ──`)
}

// ── 1. is multi-ASIN coverage already happening? ──────────────────────────────
// campaign → the ASINs advertised in it, via ad groups.
const ads = await prisma.adProductAd.findMany({
  where: { asin: { not: null } },
  select: { asin: true, adGroup: { select: { campaign: { select: { externalCampaignId: true, name: true } } } } },
})
const asinsByCampaign = new Map<string, Set<string>>()
for (const a of ads) {
  const ext = a.adGroup?.campaign?.externalCampaignId
  if (!ext || !a.asin) continue
  if (!asinsByCampaign.has(ext)) asinsByCampaign.set(ext, new Set())
  asinsByCampaign.get(ext)!.add(a.asin)
}

const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId'],
  where: { date: { gte: since }, impressions: { gt: 0 } },
  _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true },
})

interface Q { impressions: number; clicks: number; spend: number; sales: number; campaigns: Set<string>; asins: Set<string> }
const byQuery = new Map<string, Q>()
for (const t of terms) {
  const q = byQuery.get(t.query) ?? { impressions: 0, clicks: 0, spend: 0, sales: 0, campaigns: new Set<string>(), asins: new Set<string>() }
  q.impressions += t._sum.impressions ?? 0
  q.clicks += t._sum.clicks ?? 0
  q.spend += Number(t._sum.costMicros ?? 0n) / 1e6
  q.sales += (t._sum.sales7dCents ?? 0) / 100
  q.campaigns.add(t.campaignId)
  for (const a of asinsByCampaign.get(t.campaignId) ?? []) q.asins.add(a)
  byQuery.set(t.query, q)
}

const all = [...byQuery.entries()]
const multiCamp = all.filter(([, q]) => q.campaigns.size > 1)
const multiAsin = all.filter(([, q]) => q.asins.size > 1)
console.log(`\n── how many of OUR things already show on the same query ──`)
console.log(`  distinct paid queries in window     : ${int(all.length)}`)
console.log(`  served by >1 of our campaigns       : ${int(multiCamp.length)}  (${((multiCamp.length / Math.max(1, all.length)) * 100).toFixed(1)}%)`)
console.log(`  reaching >1 of our ASINs            : ${int(multiAsin.length)}  (${((multiAsin.length / Math.max(1, all.length)) * 100).toFixed(1)}%)`)
console.log(`  → >1 campaign on one query is self-competition OR coverage. Which one it is depends`)
console.log(`    on whether they sit in different placements — that is the lever, and it is unset.`)

console.log(`\n── top 25 queries by spend: how crowded are they with our OWN products? ──`)
console.log(`${pad('query', 42)} ${pad('impr', 9)} ${pad('spend', 10)} ${pad('sales', 10)} ${pad('our camps', 10)} our ASINs`)
console.log('─'.repeat(100))
for (const [query, q] of all.sort((a, b) => b[1].spend - a[1].spend).slice(0, 25)) {
  console.log(`${pad(query, 42)} ${pad(int(q.impressions), 9)} ${pad(`€${q.spend.toFixed(2)}`, 10)} ${pad(`€${q.sales.toFixed(2)}`, 10)} ${pad(String(q.campaigns.size), 10)} ${q.asins.size}`)
}

console.log(`\n── the queries where the MOST of our own products already collide ──`)
console.log(`${pad('query', 42)} ${pad('impr', 9)} ${pad('spend', 10)} ${pad('our camps', 10)} our ASINs`)
console.log('─'.repeat(90))
for (const [query, q] of all.filter(([, x]) => x.impressions > 0).sort((a, b) => b[1].asins.size - a[1].asins.size || b[1].spend - a[1].spend).slice(0, 15)) {
  console.log(`${pad(query, 42)} ${pad(int(q.impressions), 9)} ${pad(`€${q.spend.toFixed(2)}`, 10)} ${pad(String(q.campaigns.size), 10)} ${q.asins.size}`)
}

await prisma.$disconnect()
