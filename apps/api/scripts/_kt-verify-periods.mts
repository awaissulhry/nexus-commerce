/**
 * _kt-verify-periods.mts — independent audit of KT.1's SHIPPED per-row SQP period rule.
 *
 * READ-ONLY. No writes of any kind.
 *
 * Reproduces keyword-tracker.service.ts exactly (same normalisation, same `in` match, same
 * 56-day UTC-midnight `since`, same "best ASIN by impressionShare inside the resolved period"),
 * then measures A-E for IT/DE/ES/FR.
 *
 * Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-periods.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const LOOKBACKS = [14, 21, 28, 42, 56, 90]
const MAXBACK = 400 // pull a wide window once; slice in memory

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10)
const DAY = 86_400_000

function sinceFor(days: number) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function median(xs: number[]) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function main() {
  const NOW = Date.now()
  console.log('=== _kt-verify-periods — run at', new Date().toISOString(), '===\n')

  // ── 0. the watchlist, exactly as the service builds it ───────────────────────────────────
  const sets = await prisma.keywordCoverageSet.findMany({
    select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true },
    orderBy: { name: 'asc' },
  })
  console.log('KeywordCoverageSets on prod:')
  for (const s of sets) {
    const n = await prisma.keywordCoverageTerm.count({ where: { setId: s.id } })
    console.log(`  ${s.id}  mkt=${s.marketplace}  enabled=${s.enabled}  terms=${n}  "${s.name}"`)
  }

  const covSet =
    sets.find((s) => /coverage/i.test(s.name) && s.marketplace === 'IT') ?? sets.find((s) => s.marketplace === 'IT') ?? sets[0]
  if (!covSet) throw new Error('NO COVERAGE SET FOUND — abort, do not report a zero')
  const setTerms = await prisma.keywordCoverageTerm.findMany({
    where: { setId: covSet.id },
    select: { term: true, status: true },
  })
  const protections = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' },
    select: { term: true, marketplace: true },
  })
  const protectedTerms = [...new Set(protections.map((p) => norm(p.term)))]
  const covTerms = [...new Set(setTerms.map((t) => norm(t.term)))]
  const watchlist = [...new Set([...covTerms, ...protectedTerms])].sort()
  const isBranded = (t: string) => protectedTerms.some((p) => t.includes(p))
  const brandedInWatchlist = watchlist.filter(isBranded)

  console.log(`\nchosen set: "${covSet.name}" (${covSet.marketplace})`)
  console.log(`  coverage terms (normalised, deduped): ${covTerms.length}   raw rows: ${setTerms.length}`)
  console.log(`  WHITELIST protection terms:           ${protectedTerms.length}  (marketplaces: ${JSON.stringify([...new Set(protections.map((p) => p.marketplace))])})`)
  console.log(`  WATCHLIST TOTAL:                      ${watchlist.length}`)
  console.log(`  of which branded (excluded by default branded=0): ${brandedInWatchlist.length} -> ${JSON.stringify(brandedInWatchlist)}`)
  const nonBranded = watchlist.filter((t) => !isBranded(t))
  console.log(`  DEFAULT RENDERED SET (branded=0):     ${nonBranded.length}`)

  // ── sanity: does the `in:` exact match lose rows to casing/whitespace? ────────────────────
  const wide = sinceFor(MAXBACK)
  const exactAll = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: { in: [...MARKETS] }, startDate: { gte: wide }, searchQuery: { in: watchlist } },
    select: {
      marketplace: true, searchQuery: true, asin: true, startDate: true, reportPeriod: true,
      searchQueryVolume: true, searchQueryRank: true, impressionShare: true,
    },
  })
  console.log(`\nSQP rows pulled (exact \`in\` match, ${MAXBACK}d, 4 markets): ${exactAll.length}`)
  if (exactAll.length === 0) throw new Error('ZERO ROWS — refusing to report; check field names')

  const rpts = new Map<string, number>()
  for (const r of exactAll) rpts.set(r.reportPeriod, (rpts.get(r.reportPeriod) ?? 0) + 1)
  console.log('  reportPeriod mix (service does NOT filter this):', JSON.stringify([...rpts.entries()]))

  // case/whitespace leak check
  const caseLeak = await prisma.$queryRawUnsafe<Array<{ searchQuery: string; n: bigint }>>(
    `SELECT "searchQuery", COUNT(*)::bigint AS n FROM "SearchQueryPerformance"
     WHERE "marketplace" = ANY($1) AND "startDate" >= $2
       AND lower(regexp_replace(btrim("searchQuery"), '\\s+', ' ', 'g')) = ANY($3)
       AND NOT ("searchQuery" = ANY($3))
     GROUP BY 1 ORDER BY n DESC LIMIT 20`,
    [...MARKETS] as unknown as string[], wide, watchlist,
  )
  console.log(`  rows matching only AFTER normalisation (lost by exact \`in\`): ${caseLeak.length} distinct queries`,
    caseLeak.length ? JSON.stringify(caseLeak.map((c) => [c.searchQuery, Number(c.n)])) : '')

  // ── per market ───────────────────────────────────────────────────────────────────────────
  type Row = { term: string; asin: string | null; start: number; vol: number; rank: number | null; share: number }
  const summary: Record<string, unknown>[] = []

  for (const market of MARKETS) {
    const rows: Row[] = exactAll
      .filter((r) => r.marketplace === market)
      .map((r) => ({
        term: norm(r.searchQuery), asin: r.asin, start: new Date(r.startDate).setUTCHours(0, 0, 0, 0),
        vol: r.searchQueryVolume, rank: r.searchQueryRank, share: Number(r.impressionShare),
      }))

    console.log(`\n\n${'='.repeat(78)}\n=== ${market} ===\n${'='.repeat(78)}`)
    console.log(`watchlist rows in ${MAXBACK}d window: ${rows.length}`)

    // the market's full period calendar (ALL rows, not just watchlist) — needed for "the period
    // immediately before P" and for rule B.
    const calRaw = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'],
      where: { marketplace: market },
      _count: { _all: true },
      orderBy: { startDate: 'desc' },
    })
    const calendar = calRaw.map((c) => ({ start: new Date(c.startDate).setUTCHours(0, 0, 0, 0), n: c._count._all }))
    console.log(`\nperiod calendar for ${market} (all SQP rows, newest 12):`)
    for (const c of calendar.slice(0, 12)) {
      console.log(`  ${iso(new Date(c.start))}  age ${Math.floor((NOW - c.start) / DAY)}d   rows=${c.n}`)
    }
    console.log(`  distinct periods stored: ${calendar.length}`)

    // ── A. SHIPPED RULE ────────────────────────────────────────────────────────────────────
    const since56 = +sinceFor(56)
    const in56 = rows.filter((r) => r.start >= since56)
    const resolved = new Map<string, number>() // term -> period
    for (const r of in56) {
      const cur = resolved.get(r.term)
      if (cur === undefined || r.start > cur) resolved.set(r.term, r.start)
    }
    const ages = [...resolved.values()].map((p) => Math.floor((NOW - p) / DAY))
    const hist = new Map<number, number>()
    for (const p of resolved.values()) hist.set(p, (hist.get(p) ?? 0) + 1)

    console.log(`\n--- A · SHIPPED RULE (per-term newest period within 56d) — ${market} ---`)
    console.log(`  terms resolving to a period: ${resolved.size} of ${watchlist.length}   (not measured: ${watchlist.length - resolved.size})`)
    console.log(`  DISTINCT PERIODS MIXED INTO ONE GRID: ${hist.size}`)
    console.log(`  age  min=${ages.length ? Math.min(...ages) : '-'}d  median=${median(ages) ?? '-'}d  max=${ages.length ? Math.max(...ages) : '-'}d`)
    console.log(`  age histogram (period -> terms):`)
    for (const [p, n] of [...hist.entries()].sort((a, b) => b[0] - a[0])) {
      console.log(`    ${iso(new Date(p))}   age ${String(Math.floor((NOW - p) / DAY)).padStart(3)}d   terms=${n}`)
    }
    // same, restricted to the default rendered (non-branded) set
    const resolvedNB = new Map([...resolved.entries()].filter(([t]) => !isBranded(t)))
    const histNB = new Map<number, number>()
    for (const p of resolvedNB.values()) histNB.set(p, (histNB.get(p) ?? 0) + 1)
    console.log(`  [default grid, branded=0] measured ${resolvedNB.size} of ${nonBranded.length}; periods mixed = ${histNB.size}`)

    // ── B. MANDATED RULE ───────────────────────────────────────────────────────────────────
    const latestPeriod = calendar.length ? calendar[0].start : null
    const measuredB = latestPeriod === null ? 0 : new Set(rows.filter((r) => r.start === latestPeriod).map((r) => r.term)).size
    console.log(`\n--- B · MANDATED RULE (single market-latest period) — ${market} ---`)
    console.log(`  market-latest period: ${latestPeriod ? iso(new Date(latestPeriod)) : 'NONE'}  (age ${latestPeriod ? Math.floor((NOW - latestPeriod) / DAY) : '-'}d, ${latestPeriod ? calendar[0].n : 0} total rows in market)`)
    console.log(`  watchlist terms measured under B: ${measuredB} of ${watchlist.length}   (blank: ${watchlist.length - measuredB})`)

    // ── C. SENSITIVITY ─────────────────────────────────────────────────────────────────────
    console.log(`\n--- C · LOOKBACK SENSITIVITY — ${market} ---`)
    console.log('  cap   measured/107   Δ vs prev   distinct periods   max age')
    let prev = 0
    for (const cap of LOOKBACKS) {
      const s = +sinceFor(cap)
      const r2 = new Map<string, number>()
      for (const r of rows) if (r.start >= s) { const c = r2.get(r.term); if (c === undefined || r.start > c) r2.set(r.term, r.start) }
      const a2 = [...r2.values()].map((p) => Math.floor((NOW - p) / DAY))
      const p2 = new Set(r2.values()).size
      console.log(`  ${String(cap).padStart(3)}d  ${String(r2.size).padStart(6)}/${watchlist.length}   ${String(r2.size - prev).padStart(6)}      ${String(p2).padStart(6)}          ${a2.length ? Math.max(...a2) : '-'}d`)
      prev = r2.size
    }
    // unbounded
    {
      const r2 = new Map<string, number>()
      for (const r of rows) { const c = r2.get(r.term); if (c === undefined || r.start > c) r2.set(r.term, r.start) }
      const a2 = [...r2.values()].map((p) => Math.floor((NOW - p) / DAY))
      console.log(`  ${String(MAXBACK).padStart(3)}d  ${String(r2.size).padStart(6)}/${watchlist.length}   ${String(r2.size - prev).padStart(6)}      ${String(new Set(r2.values()).size).padStart(6)}          ${a2.length ? Math.max(...a2) : '-'}d   (effectively unbounded)`)
    }

    // ── D. COMPARABILITY HAZARD ────────────────────────────────────────────────────────────
    // build the rendered grid exactly as the service does (default: branded=0, market grain)
    type Grid = { term: string; period: number; share: number; vol: number; rank: number | null; asins: number; age: number }
    const grid: Grid[] = []
    for (const [term, period] of resolvedNB) {
      const inP = in56.filter((r) => r.term === term && r.start === period)
      const best = inP.reduce((a, b) => (b.share > a.share ? b : a))
      grid.push({
        term, period, share: best.share, vol: best.vol, rank: best.rank,
        asins: new Set(inP.map((r) => r.asin).filter(Boolean)).size,
        age: Math.floor((NOW - period) / DAY),
      })
    }
    grid.sort((a, b) => b.share - a.share)
    const top20 = grid.slice(0, 20)
    console.log(`\n--- D · COMPARABILITY HAZARD (top 20 by impressionShare) — ${market} ---`)
    console.log(`  rendered grid size (branded=0, measured): ${grid.length}`)
    const t20p = new Set(top20.map((g) => g.period))
    console.log(`  DIFFERENT PERIODS AMONG THE TOP 20: ${t20p.size} -> ${JSON.stringify([...t20p].sort((a, b) => b - a).map((p) => iso(new Date(p))))}`)
    console.log('  #   share     period       age   term')
    top20.forEach((g, i) => {
      console.log(`  ${String(i + 1).padStart(2)}  ${(g.share * 100).toFixed(2).padStart(6)}%  ${iso(new Date(g.period))}  ${String(g.age).padStart(3)}d  ${g.term}`)
    })
    // worst adjacent pair by period distance
    let worst: { i: number; a: Grid; b: Grid; gap: number } | null = null
    for (let i = 0; i + 1 < top20.length; i++) {
      const gap = Math.abs(top20[i].period - top20[i + 1].period) / DAY
      if (!worst || gap > worst.gap) worst = { i, a: top20[i], b: top20[i + 1], gap }
    }
    if (worst && worst.gap > 0) {
      console.log(`  WORST ADJACENT PAIR (rows #${worst.i + 1} and #${worst.i + 2}), periods ${worst.gap}d apart:`)
      console.log(`    "${worst.a.term}"  share ${(worst.a.share * 100).toFixed(2)}%  period ${iso(new Date(worst.a.period))}  age ${worst.a.age}d`)
      console.log(`    "${worst.b.term}"  share ${(worst.b.share * 100).toFixed(2)}%  period ${iso(new Date(worst.b.period))}  age ${worst.b.age}d`)
    } else {
      console.log('  WORST ADJACENT PAIR: none — all top-20 rows share one period')
    }
    // widest pair anywhere in the top 20
    if (top20.length > 1) {
      const ps = [...t20p].sort((a, b) => a - b)
      console.log(`  widest period spread anywhere in the top 20: ${(ps[ps.length - 1] - ps[0]) / DAY}d`)
    }

    // D-supplement: the WHOLE rendered grid, not just the top 20 — where do the freshest rows land?
    const gridPeriods = new Set(grid.map((g) => g.period))
    console.log(`  [whole grid] distinct periods = ${gridPeriods.size}`)
    if (gridPeriods.size > 1) {
      const newest = Math.max(...gridPeriods)
      const newestRows = grid.map((g, i) => ({ ...g, pos: i + 1 })).filter((g) => g.period === newest)
      console.log(`  [whole grid] rows on the NEWEST period ${iso(new Date(newest))} (${newestRows.length}), and their rank in the share sort:`)
      for (const r of newestRows.slice(0, 10)) console.log(`    #${r.pos}/${grid.length}  ${(r.share * 100).toFixed(2)}%  age ${r.age}d  ${r.term}`)
      let wa: { i: number; gap: number } | null = null
      for (let i = 0; i + 1 < grid.length; i++) {
        const gap = Math.abs(grid[i].period - grid[i + 1].period) / DAY
        if (!wa || gap > wa.gap) wa = { i, gap }
      }
      if (wa && wa.gap > 0) {
        const a = grid[wa.i], b = grid[wa.i + 1]
        console.log(`  [whole grid] worst adjacent pair anywhere (#${wa.i + 1}/#${wa.i + 2}), ${wa.gap}d apart:`)
        console.log(`    "${a.term}"  ${(a.share * 100).toFixed(2)}%  ${iso(new Date(a.period))}  age ${a.age}d`)
        console.log(`    "${b.term}"  ${(b.share * 100).toFixed(2)}%  ${iso(new Date(b.period))}  age ${b.age}d`)
      }
    }

    // ── E. WEEK-OVER-WEEK DELTA COMPUTABILITY ──────────────────────────────────────────────
    // "the period immediately before P": (i) exactly P-7d, and (ii) the previous period in the
    // market's stored calendar, whatever its distance.
    const calSorted = calendar.map((c) => c.start).sort((a, b) => b - a)
    const byTermPeriods = new Map<string, Set<number>>()
    for (const r of rows) {
      const s = byTermPeriods.get(r.term) ?? new Set<number>()
      s.add(r.start); byTermPeriods.set(r.term, s)
    }
    let e7 = 0, ePrevCal = 0, eAnyEarlier = 0
    const gaps: number[] = []
    for (const [term, period] of resolved) {
      const ps = byTermPeriods.get(term)!
      if (ps.has(period - 7 * DAY)) e7++
      const prevCal = calSorted.find((c) => c < period)
      if (prevCal !== undefined && ps.has(prevCal)) ePrevCal++
      const earlier = [...ps].filter((p) => p < period).sort((a, b) => b - a)
      if (earlier.length) { eAnyEarlier++; gaps.push((period - earlier[0]) / DAY) }
    }
    console.log(`\n--- E · WoW DELTA COMPUTABLE? — ${market} ---`)
    console.log(`  resolved rows (shipped rule): ${resolved.size}`)
    console.log(`  delta computable at exactly P-7d:                 ${e7}   NOT computable: ${resolved.size - e7}`)
    console.log(`  delta computable vs previous CALENDAR period:     ${ePrevCal}   NOT: ${resolved.size - ePrevCal}`)
    console.log(`  any earlier row at all (delta over some gap):     ${eAnyEarlier}   NOT: ${resolved.size - eAnyEarlier}`)
    const gh = new Map<number, number>()
    for (const g of gaps) gh.set(g, (gh.get(g) ?? 0) + 1)
    console.log(`  gap to nearest earlier row (days -> terms): ${JSON.stringify([...gh.entries()].sort((a, b) => a[0] - b[0]))}`)

    summary.push({
      market,
      A_resolved: resolved.size, A_periodsMixed: hist.size,
      A_minAge: ages.length ? Math.min(...ages) : null, A_medAge: median(ages), A_maxAge: ages.length ? Math.max(...ages) : null,
      B_latest: latestPeriod ? iso(new Date(latestPeriod)) : null, B_measured: measuredB,
      D_top20periods: t20p.size,
      E_wow7: e7, E_wowPrevCal: ePrevCal,
    })
  }

  console.log(`\n\n=== SUMMARY ===`)
  console.table(summary)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
