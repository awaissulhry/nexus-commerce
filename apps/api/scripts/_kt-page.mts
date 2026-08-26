/**
 * _ktp-page.mts — KT page study (read-only).
 *
 * Measures what a standalone Keyword Tracker page could show on day one, and re-verifies
 * the three facts the tab's design depends on:
 *   1. KeywordRank really is empty (counted directly, no catch-swallow)
 *   2. the SQP feed's exact state right now, and whether the cron has EVER recorded a run
 *   3. which keyword universe the page should track, and how much of it SQP actually covers
 *
 * NO WRITES. Every query is findMany/count/groupBy/aggregate.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_ktp-page.mts   (from apps/api)
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`) }
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '—')

async function main() {
  // ── 1 · KeywordRank, counted directly ────────────────────────────────────
  h('1 · KeywordRank')
  const krTotal = await prisma.keywordRank.count()
  line(`KeywordRank rows: ${krTotal}`)
  if (krTotal > 0) {
    const sample = await prisma.keywordRank.findMany({ take: 5, orderBy: { capturedAt: 'desc' } })
    for (const r of sample) line(`  ${r.keyword} [${r.marketplace}] org=${r.organicRank} spon=${r.sponsoredRank} vol=${r.searchVolume} src=${r.source} @ ${iso(r.capturedAt)}`)
    const bySource = await prisma.keywordRank.groupBy({ by: ['source'], _count: { _all: true } })
    for (const s of bySource) line(`  source ${s.source}: ${s._count._all}`)
  }

  // ── 2 · Rules on the two dead triggers ───────────────────────────────────
  h('2 · Rule inventory')
  const advRules = await prisma.automationRule.findMany({
    where: { domain: 'advertising' },
    select: { id: true, name: true, trigger: true, enabled: true, autonomyLevel: true, actions: true },
  })
  line(`advertising AutomationRule rows: ${advRules.length}`)
  const byTrigger = new Map<string, number>()
  for (const r of advRules) byTrigger.set(r.trigger, (byTrigger.get(r.trigger) ?? 0) + 1)
  line(`triggers in use: ${[...byTrigger.entries()].map(([t, n]) => `${t}=${n}`).sort().join(' · ')}`)
  line(`KEYWORD_RANK_BID rules: ${byTrigger.get('KEYWORD_RANK_BID') ?? 0}   SOV_BID rules: ${byTrigger.get('SOV_BID') ?? 0}`)
  // how many rules would the Keyword Tracker "Rules" segment show if liveType were a real key?
  const actionTypes = new Map<string, number>()
  for (const r of advRules) {
    const acts = Array.isArray(r.actions) ? (r.actions as Array<{ type?: string }>) : []
    for (const a of acts) if (a?.type) actionTypes.set(a.type, (actionTypes.get(a.type) ?? 0) + 1)
  }
  line(`action types across all 51: ${[...actionTypes.entries()].map(([t, n]) => `${t}=${n}`).sort().join(' · ')}`)
  line(`rules carrying a builder action type 'keyword-tracker': ${actionTypes.get('keyword-tracker') ?? 0}`)
  line(`rules carrying a builder action type 'sov': ${actionTypes.get('sov') ?? 0}`)

  // ── 3 · Does the KEYWORD_RANK_BID context have money in it? ──────────────
  h('3 · AdTarget metric columns (the rule context reads spendCents/salesCents)')
  const tgTotal = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
  const tgSpend = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, spendCents: { gt: 0 } } })
  const tgSales = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, salesCents: { gt: 0 } } })
  const tgImpr = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, impressions: { gt: 0 } } })
  line(`positive KEYWORD AdTargets: ${tgTotal}`)
  line(`  with spendCents > 0: ${tgSpend}   salesCents > 0: ${tgSales}   impressions > 0: ${tgImpr}`)
  const perfTargets = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['entityType'], _count: { _all: true },
    where: { date: { gte: new Date(Date.now() - 60 * 864e5) } },
  })
  line(`AmazonAdsDailyPerformance rows, last 60d, by entityType: ${perfTargets.map((p) => `${p.entityType}=${p._count._all}`).join(' · ')}`)

  // ── 4 · SQP feed state ───────────────────────────────────────────────────
  h('4 · SearchQueryPerformance — the feed')
  const sqpTotal = await prisma.searchQueryPerformance.count()
  const sqpLatest = await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true, ingestedAt: true }, _min: { startDate: true } })
  line(`rows: ${sqpTotal}   startDate range: ${iso(sqpLatest._min.startDate)} … ${iso(sqpLatest._max.startDate)}`)
  line(`most recent ingestedAt: ${sqpLatest._max.ingestedAt ? new Date(sqpLatest._max.ingestedAt).toISOString() : '—'}`)
  const weeks = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate', 'marketplace'], _count: { _all: true },
    orderBy: { startDate: 'desc' }, take: 60,
  })
  const byWeek = new Map<string, Map<string, number>>()
  for (const w of weeks) {
    const k = iso(w.startDate)
    if (!byWeek.has(k)) byWeek.set(k, new Map())
    byWeek.get(k)!.set(w.marketplace, w._count._all)
  }
  const mkts = [...new Set(weeks.map((w) => w.marketplace))].sort()
  line(`week        ${mkts.map((m) => m.padStart(6)).join('')}   total`)
  for (const [wk, m] of [...byWeek.entries()].sort().reverse().slice(0, 10)) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0)
    line(`${wk}  ${mkts.map((k) => String(m.get(k) ?? 0).padStart(6)).join('')}   ${tot}`)
  }

  // ── 5 · Has the SQP cron EVER recorded a run? (and is CronRun pruned?) ───
  h('5 · CronRun evidence')
  const sqpRuns = await prisma.cronRun.count({ where: { jobName: { contains: 'sqp' } } })
  line(`CronRun rows with jobName containing "sqp": ${sqpRuns}`)
  if (sqpRuns > 0) {
    const rs = await prisma.cronRun.findMany({ where: { jobName: { contains: 'sqp' } }, orderBy: { startedAt: 'desc' }, take: 5 })
    for (const r of rs) line(`  ${r.jobName} ${r.status} ${new Date(r.startedAt).toISOString()} ${r.outputSummary ?? r.errorMessage ?? ''}`)
  }
  const cronTotal = await prisma.cronRun.count()
  const cronOldest = await prisma.cronRun.aggregate({ _min: { startedAt: true }, _max: { startedAt: true } })
  line(`CronRun total rows: ${cronTotal}   oldest: ${cronOldest._min.startedAt ? new Date(cronOldest._min.startedAt).toISOString() : '—'}   newest: ${cronOldest._max.startedAt ? new Date(cronOldest._max.startedAt).toISOString() : '—'}`)
  line('(if oldest is recent, "no sqp-ingest row" could mean PRUNED rather than NEVER RAN)')
  // which jobs recorded a run in the last 24h, and which fire around 03:45 UTC
  const since = new Date(Date.now() - 36 * 3600e3)
  const recent = await prisma.cronRun.groupBy({ by: ['jobName'], _count: { _all: true }, _max: { startedAt: true }, where: { startedAt: { gte: since } } })
  line(`distinct cron jobs with a run in the last 36h: ${recent.length}`)
  const nightly = recent
    .map((r) => ({ n: r.jobName, at: r._max.startedAt ? new Date(r._max.startedAt) : null, c: r._count._all }))
    .filter((r) => r.at && r.at.getUTCHours() >= 2 && r.at.getUTCHours() <= 5)
  line('jobs whose most recent run landed between 02:00–05:00 UTC (the sqp-ingest window):')
  for (const j of nightly.sort((a, b) => (a.at! > b.at! ? -1 : 1))) line(`  ${j.n.padEnd(34)} ${j.at!.toISOString()}  runs36h=${j.c}`)

  // ── 6 · Env flags visible to this process (railway run injects prod vars) ─
  h('6 · Env flags')
  for (const k of ['NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_ENABLE_SQP_INGEST_CRON', 'NEXUS_DISABLE_SQP_INGEST_CRON', 'NEXUS_SQP_LOOKBACK', 'NEXUS_SQP_REPORT_TYPE', 'NEXUS_ADS_AUTOMATION_KILL']) {
    line(`  ${k.padEnd(32)} = ${process.env[k] ?? '(unset)'}`)
  }

  // ── 7 · The keyword universe the page would track ────────────────────────
  h('7 · Keyword universe')
  const sets = await prisma.keywordCoverageSet.findMany({ include: { terms: true } })
  line(`KeywordCoverageSet: ${sets.length}`)
  for (const s of sets) line(`  "${s.name}" portfolio=${s.portfolioId} mkt=${s.marketplace} enabled=${s.enabled} terms=${s.terms.length} (ACTIVE ${s.terms.filter((t) => t.status === 'ACTIVE').length}, control ${s.terms.filter((t) => t.isControl).length})`)
  const prot = await prisma.adKeywordProtection.findMany()
  line(`AdKeywordProtection: ${prot.length} — ${prot.map((p) => `${p.term}[${p.mode}${p.marketplace ? '/' + p.marketplace : ''}]`).join(' · ')}`)
  const posTargets = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false },
    select: { expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
    take: 5000,
  })
  const bidPairs = new Set<string>()
  for (const t of posTargets) {
    const kw = (t.expressionValue ?? '').trim().toLowerCase()
    const mk = t.adGroup?.campaign?.marketplace ?? ''
    if (kw) bidPairs.add(`${kw}|${mk}`)
  }
  line(`distinct positive KEYWORD (text × market) pairs we bid on: ${bidPairs.size}`)
  const bidMkts = new Map<string, number>()
  for (const p of bidPairs) { const m = p.split('|')[1] || '(none)'; bidMkts.set(m, (bidMkts.get(m) ?? 0) + 1) }
  line(`  by market: ${[...bidMkts.entries()].sort().map(([m, n]) => `${m}=${n}`).join(' · ')}`)

  // ── 8 · Vocabulary check: do SQP and Campaign agree on marketplace codes? ─
  h('8 · Marketplace vocabulary')
  const sqpMkts = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace'], _count: { _all: true } })
  line(`SQP marketplace values: ${sqpMkts.map((m) => `${m.marketplace}=${m._count._all}`).sort().join(' · ')}`)
  const campMkts = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
  line(`Campaign marketplace values: ${campMkts.map((m) => `${m.marketplace}=${m._count._all}`).sort().join(' · ')}`)

  // ── 9 · Overlap: how much of each keyword universe does SQP cover? ────────
  h('9 · SQP coverage of each candidate keyword set')
  const allSqp = await prisma.searchQueryPerformance.findMany({
    select: { searchQuery: true, marketplace: true, startDate: true, asin: true, impressionShare: true, searchQueryVolume: true, searchQueryRank: true },
  })
  const sqpEver = new Set<string>()
  const sqpQueriesEver = new Set<string>()
  let maxStart = 0
  for (const r of allSqp) {
    sqpEver.add(`${r.searchQuery.trim().toLowerCase()}|${r.marketplace}`)
    sqpQueriesEver.add(r.searchQuery.trim().toLowerCase())
    maxStart = Math.max(maxStart, +r.startDate)
  }
  line(`SQP distinct (query × market) pairs ever: ${sqpEver.size}   distinct queries: ${sqpQueriesEver.size}`)
  const latestWeekRows = allSqp.filter((r) => +r.startDate === maxStart)
  const sqpLatestPairs = new Set(latestWeekRows.map((r) => `${r.searchQuery.trim().toLowerCase()}|${r.marketplace}`))
  line(`latest stored week ${iso(new Date(maxStart))}: ${latestWeekRows.length} rows · ${sqpLatestPairs.size} distinct (query × market)`)

  const coverTerms = sets.flatMap((s) => s.terms.map((t) => ({ term: t.term.trim().toLowerCase(), mkt: s.marketplace, status: t.status })))
  const hit = (pairs: Set<string>, term: string, mkt: string) => pairs.has(`${term}|${mkt}`)
  const coverEver = coverTerms.filter((t) => hit(sqpEver, t.term, t.mkt)).length
  const coverLatest = coverTerms.filter((t) => hit(sqpLatestPairs, t.term, t.mkt)).length
  line(`coverage-set terms: ${coverTerms.length} → in SQP ever: ${coverEver} · in latest stored week: ${coverLatest}`)
  const protHitEver = prot.filter((p) => [...sqpQueriesEver].some((q) => q.includes(p.term.trim().toLowerCase()))).length
  line(`protected terms: ${prot.length} → appearing (as a substring) in any SQP query: ${protHitEver}`)
  let bidEver = 0, bidLatest = 0
  for (const p of bidPairs) { if (sqpEver.has(p)) bidEver++; if (sqpLatestPairs.has(p)) bidLatest++ }
  line(`bid keyword×market pairs: ${bidPairs.size} → in SQP ever: ${bidEver} · in latest stored week: ${bidLatest}`)

  // ── 10 · Day-one page: what a share-first grid would render ──────────────
  h('10 · Day-one grid, from the latest stored week per market')
  const latestPerMkt = new Map<string, number>()
  for (const r of allSqp) {
    const cur = latestPerMkt.get(r.marketplace) ?? 0
    if (+r.startDate > cur) latestPerMkt.set(r.marketplace, +r.startDate)
  }
  for (const [mkt, ts] of [...latestPerMkt.entries()].sort()) {
    const rows = allSqp.filter((r) => r.marketplace === mkt && +r.startDate === ts)
    const pairs = new Set(rows.map((r) => r.searchQuery.trim().toLowerCase()))
    const withAsin = rows.filter((r) => r.asin).length
    line(`${mkt}: latest week ${iso(new Date(ts))} · ${rows.length} rows · ${pairs.size} distinct queries · ASIN-scoped ${withAsin}/${rows.length}`)
  }
  // top rows the page would show, most-searched first, best ASIN per query
  const best = new Map<string, { q: string; mkt: string; vol: number; rank: number | null; share: number; asin: string | null; asins: number }>()
  for (const r of allSqp) {
    if (+r.startDate !== (latestPerMkt.get(r.marketplace) ?? 0)) continue
    const k = `${r.searchQuery.trim().toLowerCase()}|${r.marketplace}`
    const share = Number(r.impressionShare)
    const e = best.get(k)
    if (!e) best.set(k, { q: r.searchQuery, mkt: r.marketplace, vol: r.searchQueryVolume, rank: r.searchQueryRank, share, asin: r.asin, asins: 1 })
    else { e.asins++; if (share > e.share) { e.share = share; e.asin = r.asin } }
  }
  const top = [...best.values()].sort((a, b) => b.vol - a.vol).slice(0, 12)
  line()
  line('query                                    mkt    volume  mktRank   bestShare  ourASINs')
  for (const t of top) line(`${t.q.slice(0, 40).padEnd(40)} ${t.mkt.padEnd(4)} ${String(t.vol).padStart(8)} ${String(t.rank ?? '—').padStart(8)}  ${(t.share * 100).toFixed(3).padStart(8)}%  ${String(t.asins).padStart(6)}`)
  const multi = [...best.values()].filter((b) => b.asins > 1).length
  line(`rows where more than one of our ASINs competes: ${multi} / ${best.size}`)

  // ── 11 · Week-over-week Δ: is it computable? ─────────────────────────────
  h('11 · Week-over-week share Δ — computable?')
  const weekList = [...new Set(allSqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  line(`distinct stored weeks: ${weekList.length} → ${weekList.slice(0, 6).map((t) => iso(new Date(t))).join(' · ')}`)
  for (let i = 0; i + 1 < Math.min(weekList.length, 5); i++) {
    const a = new Set(allSqp.filter((r) => +r.startDate === weekList[i]).map((r) => `${r.searchQuery}|${r.marketplace}|${r.asin ?? ''}`))
    const b = new Set(allSqp.filter((r) => +r.startDate === weekList[i + 1]).map((r) => `${r.searchQuery}|${r.marketplace}|${r.asin ?? ''}`))
    let n = 0; for (const k of a) if (b.has(k)) n++
    line(`  ${iso(new Date(weekList[i]))} vs ${iso(new Date(weekList[i + 1]))}: ${a.size} vs ${b.size} rows · ${n} comparable query×ASIN keys`)
  }

  // ── 12 · Spend per query — for the "what this term costs" column ─────────
  h('12 · Ad spend per query (AmazonAdsSearchTerm, last 30d)')
  const stSince = new Date(Date.now() - 30 * 864e5)
  const st = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'marketplace'],
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    where: { date: { gte: stSince } },
  })
  line(`distinct (query × market) with paid traffic in 30d: ${st.length}`)
  const stPairs = new Set(st.map((r) => `${r.query.trim().toLowerCase()}|${r.marketplace}`))
  let joinable = 0
  for (const k of sqpLatestPairs) if (stPairs.has(k)) joinable++
  line(`of the ${sqpLatestPairs.size} SQP pairs in the latest stored week, ${joinable} also have paid spend in the last 30d`)
  let everJoin = 0
  for (const k of sqpEver) if (stPairs.has(k)) everJoin++
  line(`of the ${sqpEver.size} SQP pairs ever, ${everJoin} also have paid spend in the last 30d`)
  line(`paid pairs with NO SQP row at all: ${[...stPairs].filter((k) => !sqpEver.has(k)).length}`)

  line()
  line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
