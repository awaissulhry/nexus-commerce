/**
 * RA.BASIS-B B1 — the SQP recency guard, BEFORE vs AFTER, on production data.
 *
 * A behaviour change to a live bidding engine is not verified by a unit test. This reads what
 * `ad-rank-defend` actually resolves for every campaign it would evaluate, both ways, and prints
 * the difference.
 *
 *   BEFORE: `sqpImpressionShareForAsins` — newest week, no age check at all.
 *   AFTER : `sqpShareForAsins` + the engine's guard — null when `freshness === 'too-old'`.
 *
 * ── 🔴 Result, 2026-08-16 — and it is NOT the no-op it was expected to be ───────────────────────
 *
 *   evaluated 220 · open-loop before 98 · open-loop after 101 · CHANGED 3
 *
 *   IT Racing Suit CE Exact · CE Broad Only · X Phrase Only
 *     before  0.00%   ← from a week 35 DAYS old, covering 1 of 49 advertised ASINs
 *     after   null (open-loop)
 *
 * **Market-level lag is not campaign-level lag, and that is the whole finding.** All four markets'
 * newest SQP week is 2026-08-02 (14 days), which is well inside the limit — so a market-level check
 * says "fresh" and stops there. But SQP coverage is per-ASIN: these three campaigns' ASIN sets do
 * not appear in that week at all, and their newest row is 2026-07-12 — **35 days**.
 *
 * So the engine was reading a **0.00% impression share, from a five-week-old week, drawn from one
 * of forty-nine ASINs**, and feeding it to a rank-defend loop as achieved impression share. To that
 * loop 0% means "we hold nothing, push bias UP". A stale zero is the most expensive possible wrong
 * answer here, and it is indistinguishable from a real zero without the age and the basis.
 *
 * Run:  npx tsx apps/api/scripts/_basis-sqp-guard.mts 2>&1 | grep -v '^prisma:query'
 */
import { resolve } from 'path'
import { config } from 'dotenv'
// env FIRST — `db.js` reads DATABASE_URL at import time, so a later dotenv call is too late.
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const prisma = (await import('../src/db.js')).default
const { sqpShareForAsins, sqpImpressionShareForAsins, SQP_STALL_DAYS } =
  await import('../src/services/advertising/sqp.service.js')

const pct = (v: number | null) => (v == null ? 'null (open-loop)' : `${(v * 100).toFixed(2)}%`)

async function main() {
  const now = new Date()
  console.log(`\n=== SQP feed age, per market (limit ${SQP_STALL_DAYS}d) ===`)
  const markets = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace'], _max: { startDate: true } })
  for (const m of markets.sort((a, b) => a.marketplace.localeCompare(b.marketplace))) {
    const newest = m._max.startDate
    const age = newest ? Math.floor((+now - +newest) / 86_400_000) : null
    console.log(
      `  ${m.marketplace}  newest week ${newest ? newest.toISOString().slice(0, 10) : '—'}  ` +
      `age ${age ?? '—'}d  ${age != null && age > SQP_STALL_DAYS ? '🔴 PAST LIMIT' : 'within limit'}`,
    )
  }

  // Exactly the resolution `ad-rank-defend` does: enabled ads → ASINs per campaign.
  const ads = await prisma.adProductAd.findMany({
    where: { status: 'ENABLED', asin: { not: null } },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsByCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const cid = a.adGroup?.campaignId
    if (!cid || !a.asin) continue
    const s = asinsByCampaign.get(cid) ?? new Set<string>()
    s.add(a.asin); asinsByCampaign.set(cid, s)
  }

  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: [...asinsByCampaign.keys()] } },
    select: { id: true, name: true, marketplace: true },
  })

  let differing = 0, evaluated = 0, openLoopBefore = 0, openLoopAfter = 0
  const changed: string[] = []

  console.log(`\n=== per-campaign, ${campaigns.length} campaigns with enabled ads ===`)
  for (const c of campaigns) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    if (!asins.length || !c.marketplace) continue
    evaluated++

    const before = await sqpImpressionShareForAsins(c.marketplace, asins)
    const reading = await sqpShareForAsins(c.marketplace, asins, now)
    const after = reading.freshness === 'too-old' ? null : reading.share

    if (before == null) openLoopBefore++
    if (after == null) openLoopAfter++
    if (before !== after) {
      differing++
      changed.push(`  🔴 ${c.marketplace} ${c.name}\n       before ${pct(before)} → after ${pct(after)}  (${reading.freshness}, ${reading.ageDays}d, ${reading.contributors.withData}/${reading.contributors.total} ASINs)`)
    }
  }

  console.log(`  evaluated:            ${evaluated}`)
  console.log(`  open-loop BEFORE:     ${openLoopBefore}`)
  console.log(`  open-loop AFTER:      ${openLoopAfter}`)
  console.log(`  campaigns CHANGED:    ${differing}`)
  if (changed.length) { console.log('\n=== changes ==='); changed.forEach((l) => console.log(l)) }
  else console.log('\n✅ No campaign resolves differently. The guard is armed and does not trip at this lag.')

  // A worked example of each state, so the four are legible rather than asserted.
  console.log('\n=== the four states, sampled ===')
  const seen = new Set<string>()
  for (const c of campaigns) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    if (!asins.length || !c.marketplace) continue
    const r = await sqpShareForAsins(c.marketplace, asins, now)
    const key = r.freshness + (r.share === 0 ? ':zero' : '')
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`  [${key}] ${c.marketplace} ${c.name}`)
    console.log(`      share=${pct(r.share)} age=${r.ageDays}d week=${r.weekStart} basis=${r.contributors.withData}/${r.contributors.total}`)
    console.log(`      reason: ${r.reason ?? '—'}`)
  }

  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
