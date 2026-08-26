import '../src/env.js'
import prisma from '../src/db.js'

const LOOKBACK = 56
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10)
const J = (o: unknown) => console.log(JSON.stringify(o, null, 1))

async function main() {
  console.log('TODAY (script clock):', new Date().toISOString())

  // ── periods ──
  const allPeriods = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'startDate'], _count: { _all: true },
  })
  const pb: Record<string, Array<[string, number]>> = {}
  for (const p of allPeriods) (pb[p.marketplace] ??= []).push([iso(p.startDate), p._count._all])
  for (const k of Object.keys(pb)) pb[k].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  console.log('=== SQP PERIODS PER MARKET (newest first) [startDate, rows] ===')
  J(pb)

  const sets = await prisma.keywordCoverageSet.findMany({
    select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true }, orderBy: { name: 'asc' },
  })
  console.log('=== coverage sets ===')
  J(sets)
  const protections = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' }, select: { term: true, marketplace: true },
  })
  console.log('WHITELIST protection terms:', protections.length, protections.map((p) => `${p.term}${p.marketplace ? `(${p.marketplace})` : ''}`).join(', '))

  const market = 'IT'
  const chosenSet = sets.find((s) => s.marketplace === market) ?? sets[0]!
  const setTerms = await prisma.keywordCoverageTerm.findMany({ where: { setId: chosenSet.id }, select: { term: true } })
  const protectedTerms = [...new Set(protections.filter((p) => !p.marketplace || p.marketplace === market).map((p) => norm(p.term)))]
  const isBranded = (t: string) => protectedTerms.some((p) => t.includes(p))
  const watchlist = [...new Set([...setTerms.map((t) => norm(t.term)), ...protectedTerms])].sort()
  const visible = watchlist.filter((t) => !isBranded(t))
  console.log(`IT set="${chosenSet.name}" setTerms=${setTerms.length} watchlist=${watchlist.length} visible(brand excluded)=${visible.length}`)

  // ── all rows, all periods, for the visible terms ──
  const raw = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: market, searchQuery: { in: visible } },
    select: {
      searchQuery: true, asin: true, startDate: true, searchQueryVolume: true,
      searchQueryRank: true, impressionShare: true, impressionsTotal: true, impressionsBrand: true,
    },
  })
  type R = (typeof raw)[number]
  const byTP = new Map<string, Map<string, R[]>>()
  for (const r of raw) {
    const t = norm(r.searchQuery), p = iso(r.startDate)
    const m = byTP.get(t) ?? new Map<string, R[]>()
    m.set(p, [...(m.get(p) ?? []), r])
    byTP.set(t, m)
  }
  const bestOf = (arr: R[]) => arr.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))

  const now = Date.now()
  const since = new Date(); since.setUTCDate(since.getUTCDate() - LOOKBACK); since.setUTCHours(0, 0, 0, 0)

  const rows = visible.map((t) => {
    const m = byTP.get(t)
    const ever = m ? [...m.keys()].sort() : []
    const win = ever.filter((p) => new Date(`${p}T00:00:00Z`) >= since)
    const pick = win.length ? win[win.length - 1] : null
    const best = pick ? bestOf(m!.get(pick)!) : null
    return {
      term: t, asOf: pick,
      ageDays: pick ? Math.floor((now - new Date(`${pick}T00:00:00Z`).getTime()) / 86400000) : null,
      share: best ? Number(best.impressionShare) : null,
      vol: best?.searchQueryVolume ?? null,
      rank: best?.searchQueryRank ?? null,
      bestAsin: best?.asin ?? null,
      asins: pick ? new Set(m!.get(pick)!.map((x) => x.asin).filter(Boolean)).size : 0,
      ever, win, measured: !!pick,
    }
  })
  const meas = rows.filter((r) => r.measured)
  const ages = meas.map((r) => r.ageDays!).sort((a, b) => a - b)
  console.log(`IT measured=${meas.length}/${rows.length} · ages min=${ages[0]} med=${ages[Math.floor(ages.length / 2)]} max=${ages[ages.length - 1]}`)
  const spread: Record<string, number> = {}
  for (const r of meas) spread[r.asOf!] = (spread[r.asOf!] ?? 0) + 1
  console.log('periods used by the IT grid:', JSON.stringify(spread))

  // ── THE DEFAULT VIEW AS AN OPERATOR SEES IT, sorted by share desc ──
  console.log('\n=== THE PAGE, SORTED BY "Our impression share" DESC — TOP 20 ===')
  const byShare = [...meas].sort((a, b) => b.share! - a.share!)
  J(byShare.slice(0, 20).map((r, i) => ({
    pos: i + 1, term: r.term, share: `${(r.share! * 100).toFixed(2)}%`, asOf: r.asOf, ageDays: r.ageDays, vol: r.vol,
  })))

  // ── FM4 refined: when does each row's asOf cross the 56d edge ──
  console.log('\n=== FM4b. WHEN EACH PERIOD IN VIEW FALLS OFF THE 56d EDGE ===')
  const perPeriod = Object.entries(spread).sort()
  for (const [p, n] of perPeriod) {
    const drop = new Date(`${p}T00:00:00Z`); drop.setUTCDate(drop.getUTCDate() + LOOKBACK + 1)
    const daysLeft = Math.ceil((drop.getTime() - now) / 86400000)
    console.log(`period ${p} carries ${n} rows · leaves the window on ${iso(drop)} (in ${daysLeft} days)`)
  }
  // rows that will actually VANISH (no older-but-still-in-window fallback) at each drop
  console.log('--- rows that VANISH entirely vs fall back to an older period ---')
  for (const [p] of perPeriod) {
    const drop = new Date(`${p}T00:00:00Z`); drop.setUTCDate(drop.getUTCDate() + LOOKBACK + 1)
    const affected = meas.filter((r) => r.asOf === p)
    // at drop date, what is still in window for those terms?
    const cutoff = new Date(drop); cutoff.setUTCDate(cutoff.getUTCDate() - LOOKBACK)
    const vanish = affected.filter((r) => !r.ever.some((q) => new Date(`${q}T00:00:00Z`) >= cutoff))
    const fallback = affected.length - vanish.length
    console.log(`on ${iso(drop)}: ${affected.length} rows lose period ${p} → ${vanish.length} become "not measured", ${fallback} silently fall back to an OLDER week`)
  }

  // ── FM3 fine granularity: exact day-by-day row count ──
  console.log('\n=== FM3b. IT measured-row count day by day if no new SQP period ever arrives ===')
  for (let d = 0; d <= 60; d += 1) {
    const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() + d - LOOKBACK); cutoff.setUTCHours(0, 0, 0, 0)
    const n = rows.filter((r) => r.ever.some((p) => new Date(`${p}T00:00:00Z`) >= cutoff)).length
    if (d === 0 || d === 60 || n !== rows.filter((r) => {
      const c2 = new Date(); c2.setUTCDate(c2.getUTCDate() + d - 1 - LOOKBACK); c2.setUTCHours(0, 0, 0, 0)
      return r.ever.some((p) => new Date(`${p}T00:00:00Z`) >= c2)
    }).length) {
      const dt = new Date(); dt.setUTCDate(dt.getUTCDate() + d)
      console.log(`t+${d}d (${iso(dt)}): ${n} of 97 rows still measured`)
    }
  }

  // ── FM6b: coverage vs what we advertise on each term ──
  console.log('\n=== FM6b. IT — the ASINs we ADVERTISE on a term vs the ASINs SQP covers ===')
  const covIT = new Set((await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', asin: { not: null } }, select: { asin: true }, distinct: ['asin'],
  })).map((r) => r.asin!))
  const kwTargets = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false, adGroup: { campaign: { marketplace: 'IT' } } },
    select: { expressionValue: true, adGroupId: true, status: true, bidCents: true },
  })
  const agIds = [...new Set(kwTargets.map((t) => t.adGroupId))]
  const adsInAg = await prisma.adProductAd.findMany({
    where: { adGroupId: { in: agIds }, asin: { not: null } }, select: { adGroupId: true, asin: true },
  })
  const asinsByAg = new Map<string, Set<string>>()
  for (const a of adsInAg) {
    const s = asinsByAg.get(a.adGroupId) ?? new Set<string>(); s.add(a.asin!); asinsByAg.set(a.adGroupId, s)
  }
  const termAsins = new Map<string, Set<string>>()
  const termBid = new Map<string, number>()
  for (const t of kwTargets) {
    const k = norm(t.expressionValue)
    const s = termAsins.get(k) ?? new Set<string>()
    for (const a of asinsByAg.get(t.adGroupId) ?? []) s.add(a)
    termAsins.set(k, s)
    termBid.set(k, Math.max(termBid.get(k) ?? 0, t.bidCents))
  }
  const gaps: any[] = []
  for (const r of meas) {
    const adA = termAsins.get(r.term)
    if (!adA || adA.size === 0) continue
    const cov = [...adA].filter((a) => covIT.has(a))
    gaps.push({
      term: r.term, pageShare: +(r.share! * 100).toFixed(2) + '%', pageBestAsin: r.bestAsin, asOf: r.asOf,
      weAdvertiseAsins: adA.size, ofThoseSqpCovers: cov.length,
      coveragePct: +((cov.length / adA.size) * 100).toFixed(0),
      maxBidCents: termBid.get(r.term),
    })
  }
  gaps.sort((a, b) => a.coveragePct - b.coveragePct || b.weAdvertiseAsins - a.weAdvertiseAsins)
  console.log(`IT measured terms we also bid on: ${gaps.length}`)
  console.log(`  with ZERO of their advertised ASINs covered by SQP: ${gaps.filter((g) => g.ofThoseSqpCovers === 0).length}`)
  console.log(`  with <50% covered: ${gaps.filter((g) => g.coveragePct < 50).length}`)
  console.log(`  fully covered: ${gaps.filter((g) => g.coveragePct === 100).length}`)
  console.log('WORST 25:')
  J(gaps.slice(0, 25))

  // ── FM6c: best-ASIN vs sum-of-our-ASINs on the SAME period ──
  console.log('\n=== FM6c. best-ASIN share vs SUM of all our covered ASIN shares, same query+period ===')
  const sv: any[] = []
  for (const r of meas) {
    const arr = byTP.get(r.term)!.get(r.asOf!)!
    if (arr.length < 2) continue
    const sum = arr.reduce((s, x) => s + Number(x.impressionShare), 0)
    sv.push({
      term: r.term, asOf: r.asOf, ourAsinRows: arr.length,
      pageShowsBest: +(r.share! * 100).toFixed(2), sumOfOurs: +(sum * 100).toFixed(2),
      understatedBy: +((sum - r.share!) * 100).toFixed(2),
      factor: r.share! > 0 ? +(sum / r.share!).toFixed(2) : null,
    })
  }
  sv.sort((a, b) => b.understatedBy - a.understatedBy)
  console.log(`terms where >1 of our ASINs holds the query in the shown week: ${sv.length} of ${meas.length}`)
  const understated = sv.map((x) => x.understatedBy).sort((a, b) => a - b)
  console.log('understatement (pp) median:', understated[Math.floor(understated.length / 2)], 'max:', understated[understated.length - 1])
  J(sv.slice(0, 15))

  // ── FM5b: does the page distinguish the three blank facts in DE? ──
  console.log('\n=== FM5b. DE — what "not measured" hides ===')
  const deRaw = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'DE', searchQuery: { in: visible } },
    select: { searchQuery: true, startDate: true, asin: true, impressionShare: true },
  })
  const deByT = new Map<string, string[]>()
  for (const r of deRaw) {
    const t = norm(r.searchQuery)
    deByT.set(t, [...new Set([...(deByT.get(t) ?? []), iso(r.startDate)])])
  }
  const deCov = new Set((await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'DE', asin: { not: null } }, select: { asin: true }, distinct: ['asin'],
  })).map((r) => r.asin!))
  const deAdv = new Set((await prisma.adProductAd.findMany({
    where: { asin: { not: null }, adGroup: { campaign: { marketplace: 'DE' } } }, select: { asin: true },
  })).map((a) => a.asin!))
  let a = 0, b = 0, c = 0
  for (const t of visible) {
    const ps = (deByT.get(t) ?? []).sort()
    if (!ps.length) { a++; continue }
    const inWin = ps.filter((p) => new Date(`${p}T00:00:00Z`) >= since)
    if (!inWin.length) b++; else c++
  }
  console.log(`DE visible=${visible.length}: (a) never a row=${a} · (b) rows exist, all >56d=${b} · measured=${c}`)
  console.log(`DE advertised ASINs=${deAdv.size} · SQP-covered=${deCov.size} · overlap=${[...deCov].filter((x) => deAdv.has(x)).length}`)
  console.log('  → the page renders (a) and (b) with the SAME string. (c) "ASIN not covered by the feed" is not even a distinguishable bucket: a term with no covered ASIN is indistinguishable from a term nobody searched.')

  // ── SANITY: verify the zeros are real, not a bad field name ──
  console.log('\n=== SANITY: verify zeros ===')
  console.log('SQP total rows:', await prisma.searchQueryPerformance.count())
  console.log('SQP rows for the 97 visible IT terms, all time:', raw.length)
  console.log('KeywordRank rows:', await prisma.keywordRank.count())
  console.log('IT SQP rows in the newest IT period:', await prisma.searchQueryPerformance.count({
    where: { marketplace: 'IT', startDate: new Date('2026-07-26T00:00:00Z') },
  }))

  await prisma.$disconnect()
}
main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
