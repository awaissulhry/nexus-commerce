import '../src/env.js'
import prisma from '../src/db.js'

const LOOKBACK = 56
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10)
const J = (o: unknown) => console.log(JSON.stringify(o, null, 1))
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

async function main() {
  const market = 'IT'
  const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, marketplace: true, name: true } })
  const set = sets.find((s) => s.marketplace === market)!
  const setTerms = await prisma.keywordCoverageTerm.findMany({ where: { setId: set.id }, select: { term: true } })
  const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, marketplace: true } })
  const protectedTerms = [...new Set(prot.filter((p) => !p.marketplace || p.marketplace === market).map((p) => norm(p.term)))]
  const isBranded = (t: string) => protectedTerms.some((p) => t.includes(p))
  const watchlist = [...new Set([...setTerms.map((t) => norm(t.term)), ...protectedTerms])].sort()
  const visible = watchlist.filter((t) => !isBranded(t))

  const raw = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: market, searchQuery: { in: watchlist } },
    select: { searchQuery: true, asin: true, startDate: true, searchQueryVolume: true, impressionShare: true },
  })
  type R = (typeof raw)[number]
  const idx = new Map<string, Map<string, R[]>>()
  for (const r of raw) {
    const t = norm(r.searchQuery), p = iso(r.startDate)
    const m = idx.get(t) ?? new Map<string, R[]>()
    m.set(p, [...(m.get(p) ?? []), r]); idx.set(t, m)
  }
  const bestShare = (arr: R[]) => arr.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))

  const since = new Date(); since.setUTCDate(since.getUTCDate() - LOOKBACK); since.setUTCHours(0, 0, 0, 0)
  const now = Date.now()

  function resolve(terms: string[], asinFilter: Set<string> | null) {
    return terms.map((t) => {
      const m = idx.get(t)
      if (!m) return { term: t, asOf: null as string | null, share: null as number | null, age: null as number | null, vol: null as number | null }
      const periods = [...m.keys()].sort().filter((p) => new Date(`${p}T00:00:00Z`) >= since)
      // apply the ASIN filter exactly like the service's `asin: { in: scope.asins }`
      const usable = periods.filter((p) => (asinFilter ? m.get(p)!.some((r) => r.asin && asinFilter.has(r.asin)) : true))
      const pick = usable.length ? usable[usable.length - 1] : null
      if (!pick) return { term: t, asOf: null, share: null, age: null, vol: null }
      const arr = asinFilter ? m.get(pick)!.filter((r) => r.asin && asinFilter.has(r.asin)) : m.get(pick)!
      const b = bestShare(arr)
      return {
        term: t, asOf: pick, share: Number(b.impressionShare),
        age: Math.floor((now - new Date(`${pick}T00:00:00Z`).getTime()) / 86400000),
        vol: b.searchQueryVolume,
      }
    })
  }

  // share of a term in an arbitrary period (best ASIN, no filter) — the "common period" truth
  const shareIn = (t: string, p: string, f: Set<string> | null) => {
    const arr = idx.get(t)?.get(p)
    if (!arr) return null
    const a2 = f ? arr.filter((r) => r.asin && f.has(r.asin)) : arr
    if (!a2.length) return null
    return Number(bestShare(a2).impressionShare)
  }

  function inversions(rows: ReturnType<typeof resolve>, f: Set<string> | null, label: string) {
    const meas = rows.filter((r) => r.asOf)
    const found: any[] = []
    for (const A of meas) for (const B of meas) {
      if (A.term === B.term || A.asOf === B.asOf) continue
      if (!(A.share! > B.share!)) continue
      const pa = new Set(idx.get(A.term)!.keys()), pb = new Set(idx.get(B.term)!.keys())
      for (const p of [...pa].filter((x) => pb.has(x)).sort()) {
        const sa = shareIn(A.term, p, f), sb = shareIn(B.term, p, f)
        if (sa == null || sb == null) continue
        if (sb > sa) found.push({
          above: A.term, aboveShare: pct(A.share!), aboveAsOf: A.asOf,
          below: B.term, belowShare: pct(B.share!), belowAsOf: B.asOf,
          commonPeriod: p, aInCommon: pct(sa), bInCommon: pct(sb),
          pageGapPP: +((A.share! - B.share!) * 100).toFixed(2),
          truthGapPP: +((sb - sa) * 100).toFixed(2),
        })
      }
    }
    found.sort((x, y) => (y.truthGapPP + y.pageGapPP) - (x.truthGapPP + x.pageGapPP))
    console.log(`\n--- ${label}: measured=${meas.length}, periods=${JSON.stringify(meas.reduce((o: any, r) => ((o[r.asOf!] = (o[r.asOf!] ?? 0) + 1), o), {}))}`)
    console.log(`    inverted (A,B,commonWeek) triples=${found.length}  distinct pairs=${new Set(found.map((x) => `${x.above}|${x.below}`)).size}`)
    J(found.slice(0, 10))
    return found
  }

  console.log('=== FM1-A. DEFAULT VIEW (IT, brand excluded, market scope) ===')
  const def = resolve(visible, null)
  inversions(def, null, 'default view')

  console.log('\n=== FM1-B. BRAND TERMS INCLUDED (one click on the toolbar toggle) ===')
  const withBrand = resolve(watchlist, null)
  inversions(withBrand, null, 'brand included')
  console.log('brand-term rows:')
  J(withBrand.filter((r) => isBranded(r.term)).map((r) => ({ term: r.term, asOf: r.asOf, age: r.age, share: r.share == null ? null : pct(r.share) })))

  // ── scoped views: what an ASIN filter does to the period spread ──
  console.log('\n=== FM1-C. SCOPED VIEWS — the ASIN filter pushes rows onto DIFFERENT weeks ===')
  const campaigns = await prisma.campaign.findMany({
    where: { marketplace: 'IT' }, select: { id: true, name: true, portfolioId: true },
  })
  const ads = await prisma.adProductAd.findMany({
    where: { asin: { not: null }, adGroup: { campaign: { marketplace: 'IT' } } },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsByCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const c = a.adGroup!.campaignId
    const s = asinsByCampaign.get(c) ?? new Set<string>(); s.add(a.asin!); asinsByCampaign.set(c, s)
  }
  const portfolios = new Map<string, Set<string>>()
  for (const c of campaigns) {
    if (!c.portfolioId) continue
    const s = portfolios.get(c.portfolioId) ?? new Set<string>()
    for (const a of asinsByCampaign.get(c.id) ?? []) s.add(a)
    portfolios.set(c.portfolioId, s)
  }
  // rank portfolios by how many watchlist terms they can still measure
  const pfSummary: any[] = []
  for (const [pf, asins] of portfolios) {
    const rows = resolve(visible, asins)
    const meas = rows.filter((r) => r.asOf)
    const spread = meas.reduce((o: any, r) => ((o[r.asOf!] = (o[r.asOf!] ?? 0) + 1), o), {})
    pfSummary.push({ portfolioId: pf, asins: asins.size, measured: meas.length, weeksInView: Object.keys(spread).length, spread, maxAge: Math.max(0, ...meas.map((r) => r.age!)) })
  }
  pfSummary.sort((a, b) => b.weeksInView - a.weeksInView || b.measured - a.measured)
  J(pfSummary)
  const worst = pfSummary.find((p) => p.weeksInView > 1)
  if (worst) {
    console.log(`\n>>> portfolio ${worst.portfolioId} spans ${worst.weeksInView} weeks on one grid. Inversions inside it:`)
    inversions(resolve(visible, portfolios.get(worst.portfolioId)!), portfolios.get(worst.portfolioId)!, `portfolio ${worst.portfolioId}`)
  }
  // campaigns
  const cSummary: any[] = []
  for (const c of campaigns) {
    const asins = asinsByCampaign.get(c.id)
    if (!asins || !asins.size) continue
    const rows = resolve(visible, asins)
    const meas = rows.filter((r) => r.asOf)
    if (!meas.length) continue
    const spread = meas.reduce((o: any, r) => ((o[r.asOf!] = (o[r.asOf!] ?? 0) + 1), o), {})
    cSummary.push({ campaign: c.name, id: c.id, asins: asins.size, measured: meas.length, weeksInView: Object.keys(spread).length, spread, ages: [Math.min(...meas.map((r) => r.age!)), Math.max(...meas.map((r) => r.age!))] })
  }
  cSummary.sort((a, b) => b.weeksInView - a.weeksInView || b.measured - a.measured)
  console.log(`\nIT campaigns with ads: ${cSummary.length}; campaigns whose grid spans >1 week: ${cSummary.filter((c) => c.weeksInView > 1).length}`)
  J(cSummary.slice(0, 8))
  const wc = cSummary.find((c) => c.weeksInView >= 3)
  if (wc) {
    console.log(`\n>>> campaign "${wc.campaign}" spans ${wc.weeksInView} weeks. Inversions:`)
    inversions(resolve(visible, asinsByCampaign.get(wc.id)!), asinsByCampaign.get(wc.id)!, `campaign ${wc.campaign}`)
  }

  // ── FM2. |Δ share| between consecutive stored periods ──
  console.log('\n=== FM2. |share(P) − share(P−1)| across consecutive stored IT periods, 107 watchlist terms ===')
  const deltas: any[] = []
  for (const t of watchlist) {
    const m = idx.get(t); if (!m) continue
    const ps = [...m.keys()].sort()
    for (let i = 1; i < ps.length; i++) {
      const a = Number(bestShare(m.get(ps[i - 1])!).impressionShare)
      const b = Number(bestShare(m.get(ps[i])!).impressionShare)
      deltas.push({ term: t, from: ps[i - 1], to: ps[i], a, b, abs: Math.abs(b - a), pp: +((b - a) * 100).toFixed(2) })
    }
  }
  const abs = deltas.map((d) => d.abs).sort((x, y) => x - y)
  const Q = (p: number) => +(abs[Math.floor((abs.length - 1) * p)] * 100).toFixed(3)
  console.log(`n consecutive-period transitions=${deltas.length} over ${new Set(deltas.map((d) => d.term)).size} terms`)
  console.log('percentiles of |Δ share| in PERCENTAGE POINTS:', { p10: Q(0.1), p25: Q(0.25), p50: Q(0.5), p75: Q(0.75), p90: Q(0.9), p95: Q(0.95), p99: Q(0.99), max: Q(1) })
  console.log('mean pp:', +((abs.reduce((s, v) => s + v, 0) / abs.length) * 100).toFixed(3))
  const medianShare = def.filter((r) => r.share != null).map((r) => r.share!).sort((a, b) => a - b)
  console.log('median share currently ON THE PAGE (pp):', +(medianShare[Math.floor(medianShare.length / 2)] * 100).toFixed(2))
  console.log(`transitions where |Δ| exceeds the page's MEDIAN share: ${deltas.filter((d) => d.abs > medianShare[Math.floor(medianShare.length / 2)]).length} of ${deltas.length}`)
  deltas.sort((x, y) => y.abs - x.abs)
  console.log('TOP 12 week-over-week moves:'); J(deltas.slice(0, 12))

  // ── FM2b. THE PHANTOM, LIVE: the 2 terms that jumped to 2026-07-26 ──
  console.log('\n=== FM2b. THE PHANTOM ON THE LIVE PAGE — the 2 IT rows that read a NEWER week than the other 95 ===')
  const ahead = def.filter((r) => r.asOf === '2026-07-26')
  for (const r of ahead) {
    const prev = shareIn(r.term, '2026-07-19', null)
    const row = {
      term: r.term,
      pageShows: pct(r.share!), pageAsOf: r.asOf, pageAge: r.age,
      sameTermOn_2026_07_19: prev == null ? 'no row' : pct(prev),
      changeThePageHides: prev == null ? null : `${((r.share! - prev) * 100).toFixed(2)}pp`,
      relative: prev ? `${(((r.share! - prev) / prev) * 100).toFixed(0)}%` : null,
    }
    J(row)
    // where would it sit if everyone read 2026-07-19?
    const allOn19 = def.map((x) => ({ term: x.term, s: shareIn(x.term, '2026-07-19', null) })).filter((x) => x.s != null).sort((a, b) => b.s! - a.s!)
    const posNow = [...def].filter((x) => x.asOf).sort((a, b) => b.share! - a.share!).findIndex((x) => x.term === r.term) + 1
    const posThen = allOn19.findIndex((x) => x.term === r.term) + 1
    console.log(`  rank on the page today (share desc): #${posNow} of ${def.filter((x) => x.asOf).length}`)
    console.log(`  rank if every row read 2026-07-19 : #${posThen} of ${allOn19.length}`)
  }

  // ── FM4. the cliff, and whether ANY term falls back rather than vanishing ──
  console.log('\n=== FM4. THE CLIFF ===')
  const spreadDef = def.filter((r) => r.asOf).reduce((o: any, r) => ((o[r.asOf!] = (o[r.asOf!] ?? 0) + 1), o), {})
  for (const [p, n] of Object.entries(spreadDef).sort()) {
    const drop = new Date(`${p}T00:00:00Z`); drop.setUTCDate(drop.getUTCDate() + LOOKBACK + 1)
    const cut = new Date(drop); cut.setUTCDate(cut.getUTCDate() - LOOKBACK)
    const affected = def.filter((r) => r.asOf === p)
    const fallback = affected.filter((r) => [...(idx.get(r.term)?.keys() ?? [])].some((q) => new Date(`${q}T00:00:00Z`) >= cut && q !== p))
    console.log(`${p}: ${n} rows · window edge ${iso(drop)} (t+${Math.ceil((new Date(iso(drop)).getTime() - now) / 86400000)}d) · ${fallback.length} fall back to an older week, ${affected.length - fallback.length} become "not measured"`)
  }

  await prisma.$disconnect()
}
main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
