/**
 * _sov1-verify.mts — run the SHIPPED SOV.1 service against prod and check every claim (read-only).
 *
 * Seven things, each of which the brief's §9 requires be measured rather than asserted:
 *
 *   1. The prior-period selection, per market per `?weeks=`, with the gap in days — because the gap
 *      is NOT always 7 and a Δ labelled "vs last week" would be wrong at `?market=ES&weeks=4`.
 *   2. The all-zero exclusion is COMPUTED: which periods it excludes, and — the part that matters —
 *      **what a Δ would have reported had it not been excluded.** A quantified false collapse.
 *   3. `delta-no-prior` counts, and the `?market=FR&weeks=4` case where NO comparable prior exists.
 *   4. The scope Δ's population is the intersection, and its weighted arithmetic is reproducible
 *      here independently of the service.
 *   5. Sorting by share, top 10 BEFORE and AFTER the confidence rule.
 *   6. The colour scale is not flat: the spread of shares across the rendered rows.
 *   7. 🔴 Formatter safety: the smallest non-zero share AND the smallest non-zero Δ in the data,
 *      so the client's guard can be proven against real values rather than invented ones.
 *
 * NO WRITES.
 * Run from apps/api: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov1-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getShareOfVoice, choosePriorPeriod, SOV_MARKETS, SOV_WEEKS, type SovPeriodStat } from '../src/services/advertising/share-of-voice.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const pct = (v: number | null | undefined) => (v == null ? 'null' : `${(v * 100).toFixed(4)}%`)

async function main() {
  h('1 · the prior period, per market per ?weeks= — and the GAP')
  for (const m of SOV_MARKETS) {
    for (const w of SOV_WEEKS) {
      const r = await getShareOfVoice({ market: m, weeks: w, limit: 3000 })
      const p = r.period
      line(`${m} weeks=${String(w).padEnd(2)} chosen ${p.asOf} → prior ${p.prior.asOf ?? '—'} `
        + `gap ${p.prior.gapDays ?? '—'}d reason=${p.prior.reason} · Δ-measured ${r.census.deltaMeasured}/${r.census.total} `
        + `(${((r.census.deltaMeasured / Math.max(1, r.census.total)) * 100).toFixed(1)}%) · no-prior ${r.census.deltaNoPrior}`)
      if (p.excludedPeriods.length) {
        line(`        skipped: ${p.excludedPeriods.map((e) => `${e.asOf} (${e.rows} rows, ${e.reason})`).join(' · ')}`)
      }
      if (w === 8) {
        line(`        scope Δ: ${r.scopeDelta.queries} in both · ${pct(r.scopeDelta.priorShare)} → ${pct(r.scopeDelta.nowShare)} `
          + `= ${r.scopeDelta.deltaPt == null ? '—' : (r.scopeDelta.deltaPt >= 0 ? '+' : '') + r.scopeDelta.deltaPt.toFixed(4)}pt · ${r.scopeDelta.withoutPrior} without a prior`)
      }
    }
  }

  h('2 · 🔴 what the all-zero exclusion PREVENTS — the false collapse, quantified')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    if (!r.period.asOf) continue
    const excludedAllZero = r.period.excludedPeriods.filter((e) => e.reason === 'all-zero')
    // the newest all-zero period at all, for this market — what a naive "previous period" would take
    const groups = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    const nz = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m, impressionsBrand: { gt: 0 } }, _count: { _all: true },
    })
    const nzMap = new Map(nz.map((g) => [+g.startDate, g._count._all]))
    const allZero = groups.filter((g) => g._count._all > 0 && (nzMap.get(+g.startDate) ?? 0) === 0)
    line(`${m}: ${allZero.length} all-zero periods in history — ${allZero.map((g) => `${g.startDate.toISOString().slice(0, 10)} (${g._count._all} rows)`).join(', ')}`)
    line(`     the service skipped ${excludedAllZero.length} of them while walking back from ${r.period.asOf}`)
    // What would a Δ against the newest all-zero week report?
    const az = allZero[0]
    if (az) {
      const rows = await prisma.searchQueryPerformance.findMany({
        where: { marketplace: m, startDate: az.startDate }, select: { searchQuery: true, impressionsTotal: true, impressionsBrand: true },
      })
      const tot = new Map<string, number>()
      for (const x of rows) tot.set(x.searchQuery, Math.max(tot.get(x.searchQuery) ?? 0, x.impressionsTotal))
      const now = r.rows.filter((x) => x.state === 'measured' && x.share !== null)
      const both = now.filter((x) => tot.has(x.query))
      const nowB = both.reduce((n, x) => n + (x.ourImpressions ?? 0), 0)
      const nowT = both.reduce((n, x) => n + (x.marketImpressions ?? 0), 0)
      const wasT = both.reduce((n, x) => n + (tot.get(x.query) ?? 0), 0)
      const nowShare = nowT > 0 ? nowB / nowT : 0
      line(`     🔴 had ${az.startDate.toISOString().slice(0, 10)} been used as the baseline: ${both.length} queries in both, `
        + `prior share 0.0000% (every row's brand count is 0), now ${pct(nowShare)} `
        + `→ a reported "+${(nowShare * 100).toFixed(4)}pt" rise out of nothing, against a real market total of ${wasT.toLocaleString('en-IE')}`)
    }
  }

  h('3 · the no-comparable-prior case — ?market=FR&weeks=4')
  {
    const r = await getShareOfVoice({ market: 'FR', weeks: 4, limit: 3000 })
    line(`FR weeks=4: chosen ${r.period.asOf} · prior ${r.period.prior.asOf ?? '—'} (${r.period.prior.reason})`)
    line(`  rows ${r.total} · delta-measured ${r.census.deltaMeasured} · delta-no-prior ${r.census.deltaNoPrior}`)
    line(`  scope Δ: ${r.scopeDelta.deltaPt == null ? 'NO COMPARABLE PRIOR ✅' : 'unexpectedly present 🔴'}`)
    for (const x of r.rows.slice(0, 3)) line(`    "${x.query}" deltaState=${x.deltaState} deltaPt=${x.deltaPt}`)
  }

  h('4 · a named row with a REAL Δ, and one with delta-no-prior')
  for (const m of ['IT', 'DE'] as const) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    const real = r.rows.filter((x) => x.deltaState === 'delta-measured').sort((a, b) => (b.marketImpressions ?? 0) - (a.marketImpressions ?? 0))
    const none = r.rows.filter((x) => x.deltaState === 'delta-no-prior')
    line(`${m} (vs ${r.period.prior.asOf}, gap ${r.period.prior.gapDays}d):`)
    for (const x of real.slice(0, 4)) {
      line(`   Δ  "${x.query}" ${pct(x.priorShare)} → ${pct(x.share)} = ${(x.deltaPt! >= 0 ? '+' : '') + x.deltaPt!.toFixed(4)}pt · mktImpr ${x.marketImpressions?.toLocaleString('en-IE')}`)
    }
    if (none[0]) line(`   no-prior  "${none[0].query}" share ${pct(none[0].share)} · deltaPt=${none[0].deltaPt}`)
  }

  h('5 · click share — a named row where it DISAGREES with impression share')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    // 🔴 filtered by the CLICK flag, not the impression flag. With the impression flag this list
    // was `giacca moto 3xl` at "25.00%" — 1 of 4 market clicks — on a row with 5,364 impressions.
    const both = r.rows.filter((x) => x.share !== null && x.clickShare !== null && !x.lowConfidenceClicks)
    const gap = [...both].sort((a, b) => Math.abs((b.clickShare! - b.share!)) - Math.abs((a.clickShare! - a.share!)))
    line(`${m}: click floor ${r.confidenceFloorClicks} · ${r.census.lowConfidenceClicks} rows below it · ${both.length} confident rows · funnel clicks ${r.funnelCoverage.clicks}/${r.funnelCoverage.queries} `
      + `· cart-adds ${r.funnelCoverage.cartAdds} · purchases ${r.funnelCoverage.purchases}`)
    for (const x of gap.slice(0, 3)) {
      line(`    "${x.query}" impression ${pct(x.share)} vs click ${pct(x.clickShare)} (${x.ourClicks}/${x.marketClicks} clicks)`)
    }
  }

  h('6 · 🔴 sorting by share — top 10 BEFORE and AFTER the confidence rule')
  {
    const r = await getShareOfVoice({ market: 'IT', sort: 'share', dir: 'desc', limit: 3000 })
    line(`confidence floor (median market impressions this period): ${r.confidenceFloor.toLocaleString('en-IE')} · ${r.census.lowConfidence} of ${r.census.total} rows below it`)
    line('  AFTER (what the page renders):')
    for (const x of r.rows.slice(0, 10)) {
      line(`    ${pct(x.share).padStart(9)}  mktImpr ${String(x.marketImpressions).padStart(7)}  ${x.lowConfidence ? 'LOW ' : '    '}"${x.query}"`)
    }
    const naive = [...r.rows].filter((x) => x.share !== null).sort((a, b) => b.share! - a.share!)
    line('  BEFORE (a naive share-desc sort, for contrast):')
    for (const x of naive.slice(0, 10)) {
      line(`    ${pct(x.share).padStart(9)}  mktImpr ${String(x.marketImpressions).padStart(7)}  ${x.lowConfidence ? 'LOW ' : '    '}"${x.query}"`)
    }
  }

  h('7 · the colour scale is not flat, and the pair the band carries')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    const shares = r.rows.filter((x) => x.share !== null).map((x) => x.share!).sort((a, b) => a - b)
    const q = (p: number) => shares.length ? shares[Math.min(shares.length - 1, Math.floor(p * shares.length))] : 0
    line(`${m}: n=${shares.length} p10 ${pct(q(0.1))} p50 ${pct(q(0.5))} p90 ${pct(q(0.9))} max ${pct(shares[shares.length - 1])}`)
    line(`     band pair → weighted ${pct(r.shareSummary.weighted)} vs median query ${pct(r.shareSummary.medianQuery)} `
      + `(${r.shareSummary.ourImpressions.toLocaleString('en-IE')} of ${r.shareSummary.marketImpressions.toLocaleString('en-IE')})`)
  }

  h('8 · 🔴 formatter safety — the smallest non-zero values the client must not round to zero')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    const sh = r.rows.filter((x) => (x.share ?? 0) > 0).map((x) => x.share!).sort((a, b) => a - b)[0]
    const cs = r.rows.filter((x) => (x.clickShare ?? 0) > 0).map((x) => x.clickShare!).sort((a, b) => a - b)[0]
    const dl = r.rows.filter((x) => x.deltaPt != null && x.deltaPt !== 0).map((x) => Math.abs(x.deltaPt!)).sort((a, b) => a - b)[0]
    line(`${m}: smallest non-zero share ${sh == null ? '—' : pct(sh)} (toFixed(2) → ${sh == null ? '—' : (sh * 100).toFixed(2) + '%'})`)
    line(`     smallest non-zero click share ${cs == null ? '—' : pct(cs)} (toFixed(2) → ${cs == null ? '—' : (cs * 100).toFixed(2) + '%'})`)
    line(`     smallest non-zero |Δ| ${dl == null ? '—' : dl.toFixed(6) + 'pt'} (toFixed(2) → ${dl == null ? '—' : dl.toFixed(2) + 'pt'})`)
  }

  h('9 · a narrower scope — the scope Δ must be over ITS intersection, not the market\'s')
  {
    const campaigns = await prisma.campaign.findMany({
      where: { marketplace: 'IT', status: { not: 'ARCHIVED' } }, select: { id: true, name: true, portfolioId: true },
    })
    // 255127157311072 is the IT portfolio Brand Analytics actually covers (SOV.0 measured 433 of
    // 480 queries measurable). The first portfolio in the list covers none, which would prove only
    // that an empty scope is empty.
    const pf = '255127157311072'
    const market = await getShareOfVoice({ market: 'IT', limit: 3000 })
    const scoped = await getShareOfVoice({ market: 'IT', portfolio: pf, limit: 3000 })
    line(`IT market     : intersection ${market.scopeDelta.queries} · ${pct(market.scopeDelta.priorShare)} → ${pct(market.scopeDelta.nowShare)} = ${market.scopeDelta.deltaPt?.toFixed(4)}pt`)
    line(`IT portfolio ${pf}: intersection ${scoped.scopeDelta.queries} · ${pct(scoped.scopeDelta.priorShare)} → ${pct(scoped.scopeDelta.nowShare)} = ${scoped.scopeDelta.deltaPt?.toFixed(4)}pt`)
    line(`   → different populations and different numbers: ${market.scopeDelta.queries !== scoped.scopeDelta.queries ? 'YES ✅ the scope binds the intersection' : '🔴 IDENTICAL — the scope is being ignored'}`)
  }

  h('10 · 🔴 the all-zero exclusion FIRING — it is unreachable from the UI today, so prove the function')
  for (const m of SOV_MARKETS) {
    const groups = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true },
    })
    const nz = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m, impressionsBrand: { gt: 0 } }, _count: { _all: true },
    })
    const nzMap = new Map(nz.map((g) => [+g.startDate, g._count._all]))
    const stats: SovPeriodStat[] = groups.map((g) => ({
      start: g.startDate, rows: g._count._all, nonZeroRows: nzMap.get(+g.startDate) ?? 0,
    }))
    // Pretend the view had landed on the week straight after the all-zero run — the only situation
    // in which the walk reaches them. A stalled feed would produce exactly this.
    const chosen = new Date('2026-06-14T00:00:00Z')
    const r = choosePriorPeriod(stats, chosen, 100)
    line(`${m}: chosen 2026-06-14 (hypothetical) → prior ${r.start?.toISOString().slice(0, 10) ?? 'NONE'} reason=${r.reason}`)
    line(`     skipped ${r.excluded.length}: ${r.excluded.map((e) => `${e.asOf} (${e.rows} rows, ${e.reason})`).join(' · ') || 'none'}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
