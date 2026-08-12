/**
 * _kt5-signals.mts — the three row-level signals KT.5 must render, measured (read-only).
 *
 *   §3.2  the THIRD blank state: the term has SQP rows, but none for any ASIN in the current scope
 *   §3.3  the share is our BEST single ASIN's, not the family's — and the summed bound
 *   §3.4  per-term ad coverage, and the attribution hazard it exposes
 *   §8    Δ (week-over-week) computability on the NEW watchlists, for KT.3 to build against
 *
 * Every count is against the CURRENT watchlists and the period the gate actually picks, because
 * KT.2 replaced three of the four lists and KT.1b changed the lookback.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt5-signals.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { chooseViewPeriod } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  // ── the per-market fixtures: watchlist, chosen period, advertised ASINs ──
  const watchlists = await prisma.keywordWatchlist.findMany({
    select: { marketplace: true, name: true, isDefault: true, terms: { select: { term: true, isBranded: true } } },
  })
  const state = new Map<string, { terms: string[]; period: Date | null; asins: string[]; listName: string }>()
  for (const m of MARKETS) {
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    const terms = (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
    const g = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: m }, _count: { _all: true } })
    const chosen = chooseViewPeriod(g.map((x) => ({ start: x.startDate, rows: x._count._all })))
    const ads = await prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: m } } }, select: { asin: true },
    })
    state.set(m, { terms, period: chosen.start, asins: [...new Set(ads.map((a) => a.asin!))], listName: wl?.name ?? '—' })
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.2 · the THIRD blank state — "not measurable here"')
  line('Today a blank is "no row this week" or "never measured". The third is invisible because the')
  line('scope filter and the measurement are the same query: with `asin: { in: scope.asins }` applied,')
  line('"this term has no row" and "no COVERED ASIN could ever hold this term" collapse into one.')
  line()
  line('market   watched   measured   no row this week   never measured   🔴 not measurable HERE')
  for (const m of MARKETS) {
    const st = state.get(m)!
    if (!st.period) { line(`${m}: no period`); continue }
    // with the scope filter (what the page does today)
    const inScope = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'], where: { marketplace: m, startDate: st.period, searchQuery: { in: st.terms }, asin: { in: st.asins } },
    })
    const measured = new Set(inScope.map((r) => norm(r.searchQuery)))
    // WITHOUT the ASIN filter — the extra probe state 3 needs
    const anyAsin = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'], where: { marketplace: m, startDate: st.period, searchQuery: { in: st.terms } },
    })
    const anySet = new Set(anyAsin.map((r) => norm(r.searchQuery)))
    // and ever, at any period, for any ASIN
    const ever = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'], where: { marketplace: m, searchQuery: { in: st.terms } },
    })
    const everSet = new Set(ever.map((r) => norm(r.searchQuery)))

    const blanks = st.terms.filter((t) => !measured.has(t))
    // state 3: in the chosen week for SOME asin, but not for one of ours in scope
    const notMeasurableHere = blanks.filter((t) => anySet.has(t))
    const noRowThisWeek = blanks.filter((t) => !anySet.has(t) && everSet.has(t))
    const never = blanks.filter((t) => !everSet.has(t))
    line(`${m.padEnd(8)} ${pad(st.terms.length, 7)}   ${pad(measured.size, 8)}   ${pad(noRowThisWeek.length, 16)}   ${pad(never.length, 14)}   ${pad(notMeasurableHere.length, 22)}`)
    if (notMeasurableHere.length) line(`         e.g. ${notMeasurableHere.slice(0, 4).join(' · ')}`)
  }
  line()
  line('(state 3 is measured with the ASIN filter REMOVED — one extra grouped read per view)')

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.3 · best-single-ASIN vs the summed BOUND')
  line('The share column is our BEST ASIN\'s share. Where several of our ASINs hold the query, the')
  line('family\'s presence is larger — but impressions can overlap inside one search, so the sum is an')
  line('UPPER BOUND, never a total. Checked two ways: summing the share column, and summing')
  line('impressionsBrand over the shared impressionsTotal. They must agree.')
  line()
  let worst: { m: string; term: string; best: number; sum: number; asins: number } | null = null
  let over100 = 0
  for (const m of MARKETS) {
    const st = state.get(m)!
    if (!st.period) continue
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, startDate: st.period, searchQuery: { in: st.terms }, asin: { in: st.asins } },
      select: { searchQuery: true, asin: true, impressionShare: true, impressionsBrand: true, impressionsTotal: true },
    })
    const byTerm = new Map<string, typeof rows>()
    for (const r of rows) { const k = norm(r.searchQuery); const a = byTerm.get(k) ?? []; a.push(r); byTerm.set(k, a) }
    const multi = [...byTerm.entries()].filter(([, rs]) => rs.length > 1)
    const deltas: number[] = []
    for (const [term, rs] of multi) {
      const best = Math.max(...rs.map((r) => Number(r.impressionShare)))
      const sum = rs.reduce((a, r) => a + Number(r.impressionShare), 0)
      const brandSum = rs.reduce((a, r) => a + r.impressionsBrand, 0)
      const total = Math.max(...rs.map((r) => r.impressionsTotal))
      const viaImpressions = total > 0 ? brandSum / total : 0
      deltas.push(sum - best)
      if (sum > 1) { over100++; line(`   🔴 ${m} "${term}" summed bound = ${pct(sum)} — EXCEEDS 100%, the bound is not a bound`) }
      // the two methods must agree to within rounding
      if (Math.abs(viaImpressions - sum) > 0.005) {
        line(`   ⚠ ${m} "${term}" share-sum ${pct(sum)} vs impressions-sum ${pct(viaImpressions)} — methods disagree`)
      }
      if (!worst || sum / best > worst.sum / worst.best) worst = { m, term, best, sum, asins: rs.length }
    }
    deltas.sort((a, b) => a - b)
    const med = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0
    line(`${m}: ${byTerm.size} measured terms · ${multi.length} with >1 of our ASINs · understatement median ${(med * 100).toFixed(2)}pp max ${((deltas[deltas.length - 1] ?? 0) * 100).toFixed(2)}pp`)
    const top = multi
      .map(([term, rs]) => ({ term, best: Math.max(...rs.map((r) => Number(r.impressionShare))), sum: rs.reduce((a, r) => a + Number(r.impressionShare), 0), n: rs.length }))
      .sort((a, b) => b.sum - b.best - (a.sum - a.best)).slice(0, 4)
    for (const t of top) line(`     ${t.term.slice(0, 32).padEnd(32)} best ${pct(t.best).padStart(7)} · bound ${pct(t.sum).padStart(7)} · ${(t.sum / t.best).toFixed(2)}× · ${t.n} ASINs`)
  }
  line()
  line(`⇒ rows whose summed bound exceeds 100%: ${over100} ${over100 ? '🔴 STOP CONDITION' : '✓ the bound holds everywhere'}`)
  if (worst) line(`⇒ largest ratio: ${worst.m} "${worst.term}" ${pct(worst.best)} → ${pct(worst.sum)} (${(worst.sum / worst.best).toFixed(2)}×, ${worst.asins} ASINs)`)

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.4 · 🔴 per-term AD coverage, and the attribution hazard')
  line('For each watched term we actually bid on: which ASINs sit in the ad groups bidding it, how')
  line('many of those SQP covers, and — the hazard — whether the ASIN the grid attributes the share')
  line('to is even one of them.')
  for (const m of MARKETS) {
    const st = state.get(m)!
    if (!st.period) continue
    // ad groups bidding each term, and the ASINs advertised in them
    const targets = await prisma.adTarget.findMany({
      where: {
        isNegative: false, expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] },
        adGroup: { campaign: { marketplace: m } },
      },
      select: { expressionValue: true, adGroupId: true },
    })
    const groupsByTerm = new Map<string, Set<string>>()
    for (const t of targets) {
      const k = norm(t.expressionValue)
      if (!st.terms.includes(k)) continue
      const s = groupsByTerm.get(k) ?? new Set<string>(); s.add(t.adGroupId); groupsByTerm.set(k, s)
    }
    const allGroups = [...new Set([...groupsByTerm.values()].flatMap((s) => [...s]))]
    const groupAds = allGroups.length
      ? await prisma.adProductAd.findMany({ where: { adGroupId: { in: allGroups }, asin: { not: null } }, select: { adGroupId: true, asin: true } })
      : []
    const asinsByGroup = new Map<string, Set<string>>()
    for (const a of groupAds) { const s = asinsByGroup.get(a.adGroupId) ?? new Set<string>(); s.add(a.asin!); asinsByGroup.set(a.adGroupId, s) }

    const sqpRows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, startDate: st.period, searchQuery: { in: [...groupsByTerm.keys()] }, asin: { in: st.asins } },
      select: { searchQuery: true, asin: true, impressionShare: true },
    })
    const sqpByTerm = new Map<string, typeof sqpRows>()
    for (const r of sqpRows) { const k = norm(r.searchQuery); const a = sqpByTerm.get(k) ?? []; a.push(r); sqpByTerm.set(k, a) }

    let fully = 0, zero = 0, under50 = 0, misattributed = 0
    const detail: string[] = []
    for (const [term, groups] of groupsByTerm) {
      const adAsins = new Set([...groups].flatMap((g) => [...(asinsByGroup.get(g) ?? [])]))
      const rows = sqpByTerm.get(term) ?? []
      const coveredHere = new Set(rows.map((r) => r.asin!).filter(Boolean))
      const overlap = [...coveredHere].filter((a) => adAsins.has(a))
      const cov = adAsins.size ? overlap.length / adAsins.size : 0
      if (adAsins.size && cov >= 1) fully++
      if (adAsins.size && overlap.length === 0) zero++
      if (adAsins.size && cov < 0.5) under50++
      const best = rows.length ? rows.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a)) : null
      if (best?.asin && adAsins.size && !adAsins.has(best.asin)) {
        misattributed++
        if (detail.length < 4) detail.push(`   🔴 "${term}" renders ${pct(Number(best.impressionShare))} from ${best.asin}, which is in NONE of the ${groups.size} ad group(s) bidding it (${adAsins.size} ASINs there, SQP covers ${overlap.length})`)
      }
    }
    line()
    line(`${m}: ${groupsByTerm.size} watched terms we bid on · fully ad-covered ${fully} · under 50% ${under50} · 0% covered ${zero} · 🔴 misattributed ${misattributed}`)
    for (const d of detail) line(d)
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('§8 · Δ (week-over-week) computability — published for KT.3, not built here')
  line('A Δ needs the SAME term measured in an EARLIER period as well as the chosen one. On the new')
  line('watchlists and the 42-day lookback:')
  line()
  line('market   measured   Δ computable   gap 7d   14d   21d   28d   35d+   no earlier row')
  for (const m of MARKETS) {
    const st = state.get(m)!
    if (!st.period) continue
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, searchQuery: { in: st.terms }, asin: { in: st.asins } },
      select: { searchQuery: true, startDate: true },
    })
    const periodsByTerm = new Map<string, number[]>()
    for (const r of rows) { const k = norm(r.searchQuery); const a = periodsByTerm.get(k) ?? []; a.push(+r.startDate); periodsByTerm.set(k, a) }
    const chosen = +st.period
    const measured = [...periodsByTerm.entries()].filter(([, ps]) => ps.includes(chosen))
    const gaps: Record<string, number> = { '7': 0, '14': 0, '21': 0, '28': 0, '35+': 0 }
    let none = 0
    for (const [, ps] of measured) {
      const prior = [...new Set(ps)].filter((p) => p < chosen).sort((a, b) => b - a)[0]
      if (!prior) { none++; continue }
      const days = Math.round((chosen - prior) / 86_400_000)
      const k = days <= 7 ? '7' : days <= 14 ? '14' : days <= 21 ? '21' : days <= 28 ? '28' : '35+'
      gaps[k]++
    }
    const computable = measured.length - none
    line(`${m.padEnd(8)} ${pad(measured.length, 8)}   ${pad(computable, 12)}   ${pad(gaps['7'], 6)}  ${pad(gaps['14'], 4)}  ${pad(gaps['21'], 4)}  ${pad(gaps['28'], 4)}  ${pad(gaps['35+'], 5)}   ${pad(none, 14)}`)
  }
  line()
  line('⇒ a blank Δ would be a FOURTH on-screen state, alongside 0.00%, the three blanks and the')
  line('  coverage state. KT.3 decides whether the column earns a slot with these numbers in hand.')

  h('control — prove the zeros above are measurements, not a broken query')
  const c1 = await prisma.searchQueryPerformance.count()
  const c2 = await prisma.adTarget.count({ where: { isNegative: false } })
  const c3 = await prisma.keywordWatchlistTerm.count()
  line(`SQP rows ${c1} · positive AdTargets ${c2} · watchlist terms ${c3} (any 0 here would mean the query, not the data)`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
