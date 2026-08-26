import '../src/env.js'
import prisma from '../src/db.js'

const LOOKBACK = 56
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10)
const J = (o: unknown) => console.log(JSON.stringify(o, null, 1))

async function main() {
  // ── 0. periods stored, per market ────────────────────────────────
  const allPeriods = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'startDate'],
    _count: { _all: true },
  })
  const periodsByMkt: Record<string, Array<{ start: string; rows: number }>> = {}
  for (const p of allPeriods) {
    ;(periodsByMkt[p.marketplace] ??= []).push({ start: iso(p.startDate), rows: p._count._all })
  }
  for (const k of Object.keys(periodsByMkt)) periodsByMkt[k].sort((a, b) => (a.start < b.start ? 1 : -1))
  console.log('=== 0. SQP PERIODS PER MARKET (all time) ===')
  J(periodsByMkt)

  const totalSqp = await prisma.searchQueryPerformance.count()
  console.log('total SQP rows:', totalSqp)

  // ── 1. the watchlist, exactly as the service builds it (IT default) ─
  const sets = await prisma.keywordCoverageSet.findMany({
    select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true },
    orderBy: { name: 'asc' },
  })
  console.log('=== coverage sets ===')
  J(sets)

  const protections = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' },
    select: { term: true, marketplace: true },
  })

  const out: Record<string, unknown> = {}

  for (const market of MARKETS) {
    const chosenSet = sets.find((s) => s.marketplace === market) ?? sets[0] ?? null
    const setTerms = chosenSet
      ? await prisma.keywordCoverageTerm.findMany({ where: { setId: chosenSet.id }, select: { term: true } })
      : []
    const protectedTerms = [
      ...new Set(protections.filter((p) => !p.marketplace || p.marketplace === market).map((p) => norm(p.term))),
    ]
    const isBranded = (t: string) => protectedTerms.some((p) => t.includes(p))
    const watchlist = [...new Set([...setTerms.map((t) => norm(t.term)), ...protectedTerms])].sort()
    const visible = watchlist.filter((t) => !isBranded(t)) // default: branded excluded

    // ALL rows for these terms, NO date bound — so we can see what the 56d window hides
    const rowsAll = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, searchQuery: { in: watchlist } },
      select: {
        searchQuery: true, asin: true, startDate: true,
        searchQueryVolume: true, searchQueryRank: true, impressionShare: true,
        impressionsTotal: true, impressionsBrand: true,
      },
    })

    // per term -> per period -> best-ASIN share (the service's exact reducer)
    type Per = { share: number; asin: string | null; vol: number; rank: number | null; asins: number; impTotal: number }
    const byTerm = new Map<string, Map<string, Per>>()
    const rawByTermPeriod = new Map<string, Map<string, typeof rowsAll>>()
    for (const r of rowsAll) {
      const t = norm(r.searchQuery)
      const p = iso(r.startDate)
      const m = rawByTermPeriod.get(t) ?? new Map()
      const arr = m.get(p) ?? []
      arr.push(r)
      m.set(p, arr)
      rawByTermPeriod.set(t, m)
    }
    for (const [t, pm] of rawByTermPeriod) {
      const m = new Map<string, Per>()
      for (const [p, arr] of pm) {
        const best = arr.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
        m.set(p, {
          share: Number(best.impressionShare),
          asin: best.asin,
          vol: best.searchQueryVolume,
          rank: best.searchQueryRank,
          asins: new Set(arr.map((x) => x.asin).filter(Boolean)).size,
          impTotal: best.impressionsTotal,
        })
      }
      byTerm.set(t, m)
    }

    const now = Date.now()
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - LOOKBACK)
    since.setUTCHours(0, 0, 0, 0)

    // resolved rows exactly like the page (default scope = market, branded excluded)
    const resolved = visible.map((t) => {
      const pm = byTerm.get(t)
      const inWindow = pm ? [...pm.keys()].filter((p) => new Date(`${p}T00:00:00Z`) >= since) : []
      const everAny = pm ? [...pm.keys()] : []
      inWindow.sort()
      everAny.sort()
      const pick = inWindow.length ? inWindow[inWindow.length - 1] : null
      const per = pick ? pm!.get(pick)! : null
      return {
        term: t,
        asOf: pick,
        ageDays: pick ? Math.floor((now - new Date(`${pick}T00:00:00Z`).getTime()) / 86400000) : null,
        share: per?.share ?? null,
        vol: per?.vol ?? null,
        rank: per?.rank ?? null,
        asins: per?.asins ?? 0,
        bestAsin: per?.asin ?? null,
        periodsEver: everAny,
        periodsInWindow: inWindow,
        measured: !!pick,
      }
    })

    out[market] = { chosenSet: chosenSet?.name, watchlist: watchlist.length, visible: visible.length, resolved }
  }

  // ── write the raw resolution out for the analysis passes ──
  const it = (out.IT as any).resolved as Array<any>

  console.log('\n=== 1. IT RESOLUTION SUMMARY ===')
  const meas = it.filter((r) => r.measured)
  console.log(`visible terms=${it.length} measured=${meas.length} unmeasured=${it.length - meas.length}`)
  const ages = meas.map((r) => r.ageDays as number).sort((a, b) => a - b)
  console.log('age days min/med/max:', ages[0], ages[Math.floor(ages.length / 2)], ages[ages.length - 1])
  const spread: Record<string, number> = {}
  for (const r of meas) spread[r.asOf] = (spread[r.asOf] ?? 0) + 1
  console.log('periods used by IT rows:', spread)

  // ── FM1: CROSS-TIME SORTING INVERSIONS ───────────────────────────
  console.log('\n=== FM1. CROSS-TIME SORT INVERSIONS (IT, default view) ===')
  // build per-term period->share map again for IT
  const itShares = new Map<string, Map<string, number>>()
  {
    const raw = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: { in: it.map((r) => r.term) } },
      select: { searchQuery: true, startDate: true, impressionShare: true, asin: true, searchQueryVolume: true },
    })
    const g = new Map<string, Map<string, number>>()
    for (const r of raw) {
      const t = norm(r.searchQuery)
      const p = iso(r.startDate)
      const m = g.get(t) ?? new Map<string, number>()
      m.set(p, Math.max(m.get(p) ?? 0, Number(r.impressionShare)))
      g.set(t, m)
    }
    for (const [k, v] of g) itShares.set(k, v)
  }
  const inversions: any[] = []
  for (let i = 0; i < meas.length; i++) {
    for (let j = 0; j < meas.length; j++) {
      if (i === j) continue
      const A = meas[i], B = meas[j]
      if (A.asOf === B.asOf) continue
      if (!(A.share > B.share)) continue // A ranks above B on the page
      const ma = itShares.get(A.term)!, mb = itShares.get(B.term)!
      const common = [...ma.keys()].filter((p) => mb.has(p))
      for (const p of common) {
        if (mb.get(p)! > ma.get(p)!) {
          inversions.push({
            pageAbove: A.term, pageAboveShare: A.share, pageAboveAsOf: A.asOf,
            pageBelow: B.term, pageBelowShare: B.share, pageBelowAsOf: B.asOf,
            commonPeriod: p, aInCommon: ma.get(p), bInCommon: mb.get(p),
            gapOnPage: +(A.share - B.share).toFixed(4),
            gapInCommon: +(mb.get(p)! - ma.get(p)!).toFixed(4),
          })
        }
      }
    }
  }
  inversions.sort((a, b) => b.gapInCommon + b.gapOnPage - (a.gapInCommon + a.gapOnPage))
  console.log('total inverted (A,B,commonPeriod) triples:', inversions.length)
  console.log('distinct inverted pairs:', new Set(inversions.map((x) => `${x.pageAbove}|${x.pageBelow}`)).size)
  console.log('TOP 12 by combined magnitude:')
  J(inversions.slice(0, 12))

  // ── FM2: CONSECUTIVE-PERIOD SHARE MOVES ──────────────────────────
  console.log('\n=== FM2. |share(P) - share(P-1)| across consecutive stored periods (IT) ===')
  const deltas: Array<{ term: string; from: string; to: string; a: number; b: number; abs: number }> = []
  for (const [t, m] of itShares) {
    const ps = [...m.keys()].sort()
    for (let k = 1; k < ps.length; k++) {
      const a = m.get(ps[k - 1])!, b = m.get(ps[k])!
      deltas.push({ term: t, from: ps[k - 1], to: ps[k], a, b, abs: Math.abs(b - a) })
    }
  }
  deltas.sort((x, y) => y.abs - x.abs)
  const absArr = deltas.map((d) => d.abs).sort((a, b) => a - b)
  const q = (p: number) => absArr[Math.floor((absArr.length - 1) * p)]
  console.log('n transitions:', deltas.length)
  console.log('percentiles of |Δshare| (absolute, 0..1):', {
    p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), max: q(1),
  })
  const mean = absArr.reduce((s, v) => s + v, 0) / absArr.length
  console.log('mean |Δshare|:', mean)
  const bigMoves = deltas.filter((d) => d.abs >= 0.02)
  console.log(`transitions with |Δ| >= 2 share points: ${bigMoves.length} (${((bigMoves.length / deltas.length) * 100).toFixed(1)}%)`)
  console.log('TOP 15 moves:')
  J(deltas.slice(0, 15))

  // relative moves for terms whose base share is small
  const rel = deltas.filter((d) => d.a > 0).map((d) => ({ ...d, relPct: +(((d.b - d.a) / d.a) * 100).toFixed(1) }))
  rel.sort((x, y) => Math.abs(y.relPct) - Math.abs(x.relPct))
  console.log('TOP 10 by RELATIVE move:')
  J(rel.slice(0, 10))

  // ── FM3: STALENESS DRIFT ─────────────────────────────────────────
  console.log('\n=== FM3. STALENESS DRIFT — rows still rendering if no new SQP period arrives ===')
  for (const market of MARKETS) {
    const rs = (out[market] as any).resolved as Array<any>
    const line: any = { market, visibleTerms: rs.length }
    for (const plus of [0, 7, 14, 28, 42, 56, 70]) {
      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() + plus - LOOKBACK)
      cutoff.setUTCHours(0, 0, 0, 0)
      const n = rs.filter((r) =>
        (r.periodsEver as string[]).some((p) => new Date(`${p}T00:00:00Z`) >= cutoff)
      ).length
      line[`t+${plus}d`] = n
    }
    J(line)
  }
  // exact blank date per market
  console.log('--- exact date each market goes fully blank (newest period + 56d) ---')
  for (const market of MARKETS) {
    const rs = (out[market] as any).resolved as Array<any>
    const newest = rs.flatMap((r) => r.periodsEver as string[]).sort().pop()
    if (!newest) { console.log(market, 'no rows at all for watchlist'); continue }
    const blank = new Date(`${newest}T00:00:00Z`)
    blank.setUTCDate(blank.getUTCDate() + LOOKBACK + 1)
    console.log(market, 'newest watchlist period', newest, '→ grid fully blank on', iso(blank))
  }

  // ── FM4: THE 56-DAY CLIFF ────────────────────────────────────────
  console.log('\n=== FM4. TERMS AT THE CLIFF (resolved period aged 49-56d) ===')
  for (const market of MARKETS) {
    const rs = (out[market] as any).resolved as Array<any>
    const cliff = rs.filter((r) => r.measured && r.ageDays >= 49 && r.ageDays <= 56)
    const cliffHard = cliff.filter((r) => (r.periodsInWindow as string[]).length === 1)
    console.log(`${market}: measured=${rs.filter((r: any) => r.measured).length} at 49-56d=${cliff.length} of which ONLY period in window (will vanish)=${cliffHard.length}`)
    if (cliffHard.length) J(cliffHard.slice(0, 40).map((r) => ({ term: r.term, asOf: r.asOf, ageDays: r.ageDays, share: r.share })))
  }

  // ── FM5: BLANK BUCKETS ───────────────────────────────────────────
  console.log('\n=== FM5. WHAT A BLANK ACTUALLY MEANS — bucket census ===')
  // need account-advertised ASINs per market + SQP-covered ASINs per market
  for (const market of MARKETS) {
    const rs = (out[market] as any).resolved as Array<any>
    const unmeasured = rs.filter((r) => !r.measured)
    const bucketA = unmeasured.filter((r) => (r.periodsEver as string[]).length === 0) // never any row
    const bucketB = unmeasured.filter((r) => (r.periodsEver as string[]).length > 0) // rows, all outside window
    console.log(
      `${market}: visible=${rs.length} measured=${rs.length - unmeasured.length} blank=${unmeasured.length} ` +
      `| (a) NEVER a row=${bucketA.length} | (b) rows exist but ALL older than ${LOOKBACK}d=${bucketB.length}`
    )
    if (bucketB.length) {
      J(bucketB.slice(0, 25).map((r) => {
        const newest = (r.periodsEver as string[]).slice(-1)[0]
        return {
          term: r.term, newestRowEver: newest,
          ageDays: Math.floor((Date.now() - new Date(`${newest}T00:00:00Z`).getTime()) / 86400000),
          periods: (r.periodsEver as string[]).length,
        }
      }))
    }
  }

  // ── FM6: ASIN COVERAGE ───────────────────────────────────────────
  console.log('\n=== FM6. ASIN COVERAGE OF THE SQP FEED ===')
  for (const market of MARKETS) {
    const advertised = await prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: market } } },
      select: { asin: true },
    })
    const advSet = new Set(advertised.map((a) => a.asin!))
    const covered = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: market, asin: { not: null } },
      select: { asin: true },
      distinct: ['asin'],
    })
    const covSet = new Set(covered.map((c) => c.asin!))
    const overlap = [...covSet].filter((a) => advSet.has(a))
    console.log(
      `${market}: advertised ASINs=${advSet.size} · SQP-covered ASINs=${covSet.size} · ` +
      `covered∩advertised=${overlap.length} (${((overlap.length / Math.max(1, advSet.size)) * 100).toFixed(1)}% of advertised ASINs have ANY SQP row)`
    )
    console.log(`  covered list: ${[...covSet].sort().join(', ')}`)
  }

  // For IT: for the terms we actually BID on, which ASINs are in the ad groups that hold the term,
  // and is that ASIN in the SQP-covered set?
  console.log('\n--- FM6b. IT: for each measured term we also BID on, the ASINs advertised in the ad groups holding that keyword vs the SQP-covered ASINs ---')
  const covIT = new Set(
    (await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', asin: { not: null } }, select: { asin: true }, distinct: ['asin'],
    })).map((r) => r.asin!)
  )
  const kwTargets = await prisma.adTarget.findMany({
    where: {
      marketplace: 'IT', targetType: 'KEYWORD', isNegative: false,
      keywordText: { in: it.map((r) => r.term) },
    },
    select: { keywordText: true, adGroupId: true, state: true, bidCents: true },
  })
  const agIds = [...new Set(kwTargets.map((t) => t.adGroupId).filter(Boolean))] as string[]
  const adsInAg = await prisma.adProductAd.findMany({
    where: { adGroupId: { in: agIds }, asin: { not: null } },
    select: { adGroupId: true, asin: true },
  })
  const asinsByAg = new Map<string, Set<string>>()
  for (const a of adsInAg) {
    const s = asinsByAg.get(a.adGroupId!) ?? new Set<string>()
    s.add(a.asin!)
    asinsByAg.set(a.adGroupId!, s)
  }
  const termToAdAsins = new Map<string, Set<string>>()
  for (const t of kwTargets) {
    const k = norm(t.keywordText ?? '')
    const s = termToAdAsins.get(k) ?? new Set<string>()
    for (const a of asinsByAg.get(t.adGroupId ?? '') ?? []) s.add(a)
    termToAdAsins.set(k, s)
  }
  const gaps: any[] = []
  for (const r of meas) {
    const adAsins = termToAdAsins.get(r.term)
    if (!adAsins || adAsins.size === 0) continue
    const coveredOfThose = [...adAsins].filter((a) => covIT.has(a))
    if (coveredOfThose.length < adAsins.size) {
      gaps.push({
        term: r.term,
        pageShare: r.share,
        pageBestAsin: r.bestAsin,
        asOf: r.asOf,
        asinsWeAdvertiseOnThisTerm: adAsins.size,
        ofThoseCoveredBySqp: coveredOfThose.length,
        uncovered: [...adAsins].filter((a) => !covIT.has(a)).slice(0, 12),
      })
    }
  }
  gaps.sort((a, b) => b.asinsWeAdvertiseOnThisTerm - b.ofThoseCoveredBySqp - (a.asinsWeAdvertiseOnThisTerm - a.ofThoseCoveredBySqp))
  console.log(`IT terms we bid on where at least one advertised ASIN has NO SQP coverage: ${gaps.length} of ${meas.length} measured`)
  J(gaps.slice(0, 20))

  // how much of the term's own impressions do our covered ASINs sum to vs the best-ASIN figure?
  console.log('\n--- FM6c. IT: best-ASIN share vs SUM of all our covered ASINs on the same query/period ---')
  const sumVsBest: any[] = []
  for (const r of meas.slice(0, 400)) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: r.term, startDate: new Date(`${r.asOf}T00:00:00Z`) },
      select: { asin: true, impressionShare: true, impressionsBrand: true, impressionsTotal: true },
    })
    const sum = rows.reduce((s, x) => s + Number(x.impressionShare), 0)
    if (rows.length > 1) {
      sumVsBest.push({
        term: r.term, asOf: r.asOf, nAsinRows: rows.length,
        bestAsinShare: +r.share!.toFixed(4), sumOfOurAsinShares: +sum.toFixed(4),
        understatementFactor: r.share! > 0 ? +(sum / r.share!).toFixed(2) : null,
      })
    }
  }
  sumVsBest.sort((a, b) => (b.understatementFactor ?? 0) - (a.understatementFactor ?? 0))
  console.log('terms where >1 of our ASINs holds the query in the shown period:', sumVsBest.length)
  J(sumVsBest.slice(0, 15))

  // ── FM1b: VOLUME / RANK ARE ALSO CROSS-TIME ──────────────────────
  console.log('\n=== FM1b. Market volume also moves between periods (the DEFAULT sort column) ===')
  const volMoves: any[] = []
  {
    const raw = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: { in: it.map((r) => r.term) } },
      select: { searchQuery: true, startDate: true, searchQueryVolume: true },
    })
    const g = new Map<string, Map<string, number>>()
    for (const r of raw) {
      const t = norm(r.searchQuery), p = iso(r.startDate)
      const m = g.get(t) ?? new Map<string, number>()
      m.set(p, Math.max(m.get(p) ?? 0, r.searchQueryVolume))
      g.set(t, m)
    }
    for (const [t, m] of g) {
      const ps = [...m.keys()].sort()
      for (let k = 1; k < ps.length; k++) {
        const a = m.get(ps[k - 1])!, b = m.get(ps[k])!
        if (a > 0) volMoves.push({ term: t, from: ps[k - 1], to: ps[k], volA: a, volB: b, pct: +(((b - a) / a) * 100).toFixed(1) })
      }
    }
  }
  volMoves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  const volAbs = volMoves.map((v) => Math.abs(v.pct)).sort((a, b) => a - b)
  console.log('n volume transitions:', volMoves.length, 'median |Δvol%|:', volAbs[Math.floor(volAbs.length / 2)], 'p90:', volAbs[Math.floor(volAbs.length * 0.9)])
  J(volMoves.slice(0, 10))

  // ── EXTRA: is the DEFAULT view really 97 rows / 47 multi-ASIN? ───
  console.log('\n=== EXTRA. reproduce the shipped claims ===')
  console.log('IT visible terms (branded excluded):', it.length)
  console.log('IT measured:', meas.length)
  console.log('IT terms with >1 of our ASINs in the shown period:', meas.filter((r) => r.asins > 1).length)
  console.log('IT full watchlist (branded included):', (out.IT as any).watchlist)
  console.log('IT rows with share exactly 0:', meas.filter((r) => r.share === 0).length)

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL', e)
  await prisma.$disconnect()
  process.exit(1)
})
