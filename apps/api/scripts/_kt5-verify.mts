/**
 * _kt5-verify.mts — the KT.5 payload, measured against prod (read-only).
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt5-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`) }

async function show(label: string, q: Parameters<typeof getKeywordTracker>[0]) {
  const t0 = Date.now(); const r = await getKeywordTracker(q); const ms = Date.now() - t0
  const st = (k: string) => r.rows.filter((x) => x.state === k).length
  line(`${label}  (${ms}ms)`)
  line(`   coverage: share measured across ${r.scope.resolved.asinsCovered} of ${r.scope.resolved.asins} advertised ASINs`)
  line(`   states: measured ${st('measured')} · no-row ${st('no-row-this-period')} · never ${st('never-measured')} · 🔴 not-measurable-here ${st('not-measurable-here')}`)
  const bounded = r.rows.filter((x) => x.shareBound != null)
  const over = bounded.filter((x) => (x.shareBound ?? 0) > 1)
  line(`   bound: ${bounded.length} rows carry one · max ${(Math.max(0, ...bounded.map((x) => x.shareBound ?? 0)) * 100).toFixed(2)}% · over 100%: ${over.length}`)
  const bid = r.rows.filter((x) => x.ad?.bidOnTerm)
  const mis = bid.filter((x) => x.state === 'measured' && x.ad && !x.ad.bestAsinAdvertisesTerm)
  const zero = bid.filter((x) => x.ad && x.ad.adAsins > 0 && x.ad.coveredAdAsins === 0)
  line(`   ad: ${bid.length} bid-on terms · 0%-covered ${zero.length} · 🔴 misattributed ${mis.length}`)
  for (const x of mis.slice(0, 2)) line(`      "${x.keyword}" ${((x.impressionShare ?? 0) * 100).toFixed(2)}% from ${x.bestAsin}, not in the ${x.ad!.adAsins} ASINs advertising it`)
  line(`   feed: silent ${r.feed.nightsSilent} night(s) · claims rows=0 for ${r.feed.nightsClaimingZero} · green-and-dead ${r.feed.greenAndDead} · last "${r.feed.lastRunSummary}" err="${r.feed.lastRunError ?? ''}"`)
  line(`   cliff: collapses ${r.feed.cliff.collapseOn} → week of ${r.feed.cliff.collapseToPeriod} · no week at all ${r.feed.cliff.blankOn}`)
  return r
}

async function main() {
  h('the four markets')
  for (const m of ['IT', 'DE', 'ES', 'FR'] as const) await show(`${m} · default`, { market: m })
  h('the narrow scope where state 3 dominates')
  const c = await prisma.campaign.findFirst({ where: { name: { contains: 'Gale Jacket Yellow Only' } }, select: { id: true, name: true } })
  if (c) await show(`IT · campaign "${c.name}"`, { market: 'IT', campaign: c.id })
  h('timing — same market three times, to separate warm-up from cost')
  for (const m of ['IT', 'IT', 'IT', 'FR', 'FR'] as const) {
    const t0 = Date.now(); await getKeywordTracker({ market: m }); line(`   ${m}: ${Date.now() - t0}ms`)
  }

  h('control')
  line(`SQP rows ${await prisma.searchQueryPerformance.count()} · watchlist terms ${await prisma.keywordWatchlistTerm.count()}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
// timing appendix: the same market twice, to separate connection warm-up from query cost
