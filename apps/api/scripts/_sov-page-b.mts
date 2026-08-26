/**
 * SOV page study — part B. READ-ONLY.
 *
 * What a real Share-of-Voice page would have to render, and the three states it must tell apart:
 * "no data" / "stale data" / "we hold none of this market".
 *
 * Specifically doubted and re-measured here:
 *   1. Does AmazonAdsSearchTerm carry impression-only (0-click) rows at all? Part A found ZERO
 *      queries with 0 clicks across 1,992 — implausible unless the feed is click-filtered.
 *   2. Is the SQP feed "stopped", or is its newest week structurally 2 weeks old by config?
 *      periodWindow(WEEK, now, NEXUS_SQP_LOOKBACK) answers this exactly.
 *   3. How many ASINs does SQP actually cover? ingestSqp defaults to 10 per market.
 *   4. sqpImpressionShareForAsins has no recency guard — what date does it silently return today?
 *   5. The unbid demand: how big, and what would the view look like.
 *   6. Branded vs non-branded: is a non-branded default even meaningful here?
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { periodWindow, sqpImpressionShareForAsins } = await import('../src/services/advertising/sqp.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`
const day = (d: Date) => d.toISOString().slice(0, 10)

console.log('\n═══ SOV page study — B: SQP truth, recency, unbid demand ═══\n')

// ── 1. is the ad search-term feed click-filtered? ─────────────────────────────
const since = new Date(Date.now() - 30 * 86_400_000)
const stTotal = await prisma.amazonAdsSearchTerm.count({ where: { date: { gte: since } } })
const stZeroClick = await prisma.amazonAdsSearchTerm.count({ where: { date: { gte: since }, clicks: 0 } })
const stZeroImpr = await prisma.amazonAdsSearchTerm.count({ where: { date: { gte: since }, impressions: 0 } })
const stAllTime = await prisma.amazonAdsSearchTerm.count()
const stAllTimeZeroClick = await prisma.amazonAdsSearchTerm.count({ where: { clicks: 0 } })
console.log(`AmazonAdsSearchTerm, 30d window : ${int(stTotal)} rows`)
console.log(`  with clicks = 0               : ${int(stZeroClick)}  (${p2(stZeroClick / Math.max(1, stTotal))})`)
console.log(`  with impressions = 0          : ${int(stZeroImpr)}`)
console.log(`AmazonAdsSearchTerm, all time   : ${int(stAllTime)} rows · clicks=0 on ${int(stAllTimeZeroClick)}`)
console.log(`  → if clicks=0 is ~0 rows, the report we ingest carries ONLY queries that were clicked,`)
console.log(`    and every impression figure on the tab describes clicked traffic, not all traffic.`)

// ── 2. is SQP stopped, or structurally 2 weeks behind? ────────────────────────
const lookbackEnv = process.env.NEXUS_SQP_LOOKBACK
const lookback = Math.max(1, Number(lookbackEnv) || 2)
const now = new Date()
const win = periodWindow('WEEK', now, lookback)
console.log(`\n── SQP recency ──`)
console.log(`today (UTC)                       : ${day(now)}`)
console.log(`NEXUS_SQP_LOOKBACK                : ${lookbackEnv ?? '(unset → 2)'}`)
console.log(`periodWindow('WEEK', now, ${lookback})    : ${day(win.start)} → ${day(win.end)}`)
console.log(`  ← this is the ONLY week today's cron run can write.`)

const weeks = await prisma.searchQueryPerformance.groupBy({
  by: ['startDate', 'marketplace'],
  _count: { _all: true },
  orderBy: { startDate: 'desc' },
})
const byWeek = new Map<string, Map<string, number>>()
for (const w of weeks) {
  const k = day(w.startDate)
  const m = byWeek.get(k) ?? new Map<string, number>()
  m.set(w.marketplace, w._count._all)
  byWeek.set(k, m)
}
console.log(`\nweek       total   by market`)
for (const [k, m] of [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 10)) {
  const tot = [...m.values()].reduce((a, b) => a + b, 0)
  console.log(`${k}  ${pad(int(tot), 6)}  ${[...m.entries()].sort().map(([mk, n]) => `${mk} ${n}`).join(' · ')}`)
}
const newest = [...byWeek.keys()].sort().at(-1)
console.log(`\nnewest stored week : ${newest}`)
console.log(`cron's target week : ${day(win.start)}`)
console.log(newest === day(win.start)
  ? `  → THE SAME. The feed is NOT stopped; the newest week is 2 weeks old BY CONFIGURATION.`
  : `  → DIFFERENT. The cron's target week is missing from the table — that is a genuine stall.`)

// ── 2b. has the cron ever recorded a run? ─────────────────────────────────────
const runs = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 8 })
console.log(`\nCronRun rows named 'sqp-ingest' : ${runs.length}`)
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${r.status} ${r.outputSummary ?? ''} ${r.errorMessage ?? ''}`)
if (!runs.length) {
  const anyNames = await prisma.cronRun.groupBy({ by: ['jobName'], _count: { _all: true }, orderBy: { _count: { jobName: 'desc' } }, take: 40 })
  console.log(`  (0 rows. jobName values that DO exist, to prove the column/filter is right:)`)
  console.log(`  ${anyNames.map((a) => `${a.jobName}=${a._count._all}`).join(' · ')}`)
}

// ── 3. how many ASINs does SQP actually cover? ────────────────────────────────
const asinRows = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'asin'], _count: { _all: true } })
const asinsByMkt = new Map<string, Set<string>>()
for (const r of asinRows) {
  const s = asinsByMkt.get(r.marketplace) ?? new Set<string>()
  s.add(r.asin ?? '(brand-level)')
  asinsByMkt.set(r.marketplace, s)
}
console.log(`\n── SQP coverage (ingestSqp defaults to the top 10 ASINs per market) ──`)
for (const [mk, s] of [...asinsByMkt.entries()].sort()) console.log(`  ${pad(mk, 4)} ${s.size} distinct ASINs ever ingested`)
const liveAsins = await prisma.adProductAd.findMany({ where: { status: 'ENABLED' }, select: { asin: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } } })
const advByMkt = new Map<string, Set<string>>()
for (const a of liveAsins) {
  const mk = a.adGroup?.campaign?.marketplace; if (!mk || !a.asin) continue
  const s = advByMkt.get(mk) ?? new Set<string>(); s.add(a.asin); advByMkt.set(mk, s)
}
console.log(`  vs ASINs we actually advertise (ENABLED ads):`)
for (const [mk, s] of [...advByMkt.entries()].sort()) {
  const covered = [...s].filter((a) => asinsByMkt.get(mk)?.has(a)).length
  console.log(`  ${pad(mk, 4)} ${s.size} advertised · ${covered} of them have SQP rows (${p2(covered / Math.max(1, s.size))})`)
}

// ── 4. what the rank engine silently reads today ──────────────────────────────
console.log(`\n── sqpImpressionShareForAsins: no recency guard ──`)
for (const [mk, s] of [...advByMkt.entries()].sort()) {
  const asins = [...s]
  const share = await sqpImpressionShareForAsins(mk, asins)
  const latest = await prisma.searchQueryPerformance.findFirst({ where: { marketplace: mk, asin: { in: asins } }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
  const ageDays = latest ? Math.round((+now - +latest.startDate) / 86_400_000) : null
  console.log(`  ${pad(mk, 4)} share=${share == null ? 'null (open-loop)' : p2(share)}  from week ${latest ? day(latest.startDate) : '—'}  age ${ageDays == null ? '—' : `${ageDays}d`}`)
}
console.log(`  → ad-rank-defend.job.ts:564 consumes this with no age check. A number this old is presented`)
console.log(`    to the controller as if it were current.`)

// ── 5. the three states a real SOV page must tell apart ───────────────────────
const latestWeek = newest ? new Date(`${newest}T00:00:00.000Z`) : null
if (latestWeek) {
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { startDate: latestWeek },
    select: { searchQuery: true, marketplace: true, asin: true, impressionsBrand: true, impressionsTotal: true, impressionShare: true, searchQueryVolume: true, clicksBrand: true, purchasesBrand: true },
  })
  const zeroShare = rows.filter((r) => Number(r.impressionShare) === 0).length
  const zeroTotal = rows.filter((r) => r.impressionsTotal === 0).length
  console.log(`\n── the latest stored week (${newest}) ──`)
  console.log(`  rows                                   : ${int(rows.length)}`)
  console.log(`  impressionsTotal = 0 (market unknown)  : ${int(zeroTotal)}  ← "no data", NOT "zero share"`)
  console.log(`  impressionShare  = 0 with a real total : ${int(rows.filter((r) => Number(r.impressionShare) === 0 && r.impressionsTotal > 0).length)}  ← genuinely "we hold none"`)
  console.log(`  impressionShare  = 0 overall           : ${int(zeroShare)}`)
  console.log(`  → the page cannot render one "0%" for both. share() returns 0 when total is 0, so a`)
  console.log(`    missing market total is indistinguishable from a real zero at the column level.`)
}

// ── 6. unbid demand ───────────────────────────────────────────────────────────
const sqpAll = await prisma.searchQueryPerformance.findMany({
  select: { searchQuery: true, marketplace: true, searchQueryVolume: true, impressionShare: true, impressionsBrand: true, impressionsTotal: true, purchasesBrand: true, startDate: true },
})
const sqpQ = new Set(sqpAll.map((r) => r.searchQuery.trim().toLowerCase()))
const paidAll = await prisma.amazonAdsSearchTerm.findMany({ select: { query: true } })
const paidQ = new Set(paidAll.map((r) => (r.query || '').trim().toLowerCase()).filter(Boolean))
const both = [...sqpQ].filter((q) => paidQ.has(q))
const unbid = [...sqpQ].filter((q) => !paidQ.has(q))
console.log(`\n── paid coverage vs the demand SQP can see ──`)
console.log(`  distinct queries we have ever paid on : ${int(paidQ.size)}`)
console.log(`  distinct queries SQP knows            : ${int(sqpQ.size)}`)
console.log(`  both                                  : ${int(both.length)}`)
console.log(`  in SQP, never advertised on           : ${int(unbid.length)}`)
console.log(`  ⚠ SQP only sees queries OUR ingested ASINs appeared in — this is demand we already show`)
console.log(`    up for organically and do not buy, NOT the market's whole query universe.`)

const bestUnbid = new Map<string, { vol: number; mkt: string; brand: number; total: number; when: Date }>()
for (const r of sqpAll) {
  const k = r.searchQuery.trim().toLowerCase()
  if (paidQ.has(k)) continue
  const cur = bestUnbid.get(k)
  if (!cur || r.searchQueryVolume > cur.vol) bestUnbid.set(k, { vol: r.searchQueryVolume, mkt: r.marketplace, brand: r.impressionsBrand, total: r.impressionsTotal, when: r.startDate })
}
console.log(`\n  biggest unbid queries by market search volume:`)
console.log(`  ${pad('query', 40)} ${pad('mkt', 4)} ${pad('volume', 9)} ${pad('our impr', 9)} ${pad('mkt impr', 10)} our share   week`)
for (const [q, v] of [...bestUnbid.entries()].sort((a, b) => b[1].vol - a[1].vol).slice(0, 20)) {
  console.log(`  ${pad(q, 40)} ${pad(v.mkt, 4)} ${pad(int(v.vol), 9)} ${pad(int(v.brand), 9)} ${pad(int(v.total), 10)} ${pad(v.total > 0 ? p2(v.brand / v.total) : 'no data', 11)} ${day(v.when)}`)
}

// ── 7. branded vs non-branded ─────────────────────────────────────────────────
const prot = await prisma.adKeywordProtection.findMany({ select: { term: true, marketplace: true, mode: true, matchType: true } })
console.log(`\n── branded terms (AdKeywordProtection) ──`)
console.log(`  ${prot.length} rows: ${prot.map((p) => `${p.term}[${p.mode}${p.matchType ? `/${p.matchType}` : ''}]${p.marketplace ? `/${p.marketplace}` : ''}`).join(' · ')}`)
const brandWords = [...new Set(prot.filter((p) => p.mode === 'WHITELIST').map((p) => p.term.trim().toLowerCase()).filter(Boolean))]
const isBranded = (q: string) => brandWords.some((b) => q.includes(b))
const brandedPaid = [...paidQ].filter(isBranded)
const brandedSqp = [...sqpQ].filter(isBranded)
console.log(`  paid queries containing a protected term : ${int(brandedPaid.length)} of ${int(paidQ.size)} (${p2(brandedPaid.length / Math.max(1, paidQ.size))})`)
console.log(`  SQP queries containing a protected term  : ${int(brandedSqp.length)} of ${int(sqpQ.size)} (${p2(brandedSqp.length / Math.max(1, sqpQ.size))})`)

// ── 8. ASIN-shaped "keywords" the tab renders as search terms ─────────────────
const asinLike = [...paidQ].filter((q) => /^b0[a-z0-9]{8}$/i.test(q) || /^b[0-9a-z]{9}$/i.test(q))
console.log(`\n  paid "queries" that are actually ASIN strings : ${int(asinLike.length)} of ${int(paidQ.size)}`)
console.log(`    e.g. ${asinLike.slice(0, 8).join(' · ')}`)

// ── 9. the curated list that already exists ───────────────────────────────────
const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true, _count: { select: { terms: true } } } })
console.log(`\n── KeywordCoverageSet (a curated list somebody already made) ──`)
for (const s of sets) console.log(`  ${s.name} [${s.marketplace}] portfolio=${s.portfolioId} enabled=${s.enabled} — ${s._count.terms} terms`)
const setTerms = await prisma.keywordCoverageTerm.findMany({ select: { term: true, status: true, targetSharePct: true, isControl: true, leadAsin: true, maxCpcCents: true } })
console.log(`  term columns already in the schema: status · targetSharePct · isControl · leadAsin · maxCpcCents`)
console.log(`    with a targetSharePct set : ${setTerms.filter((t) => t.targetSharePct != null).length} · isControl: ${setTerms.filter((t) => t.isControl).length} · leadAsin set: ${setTerms.filter((t) => t.leadAsin).length} · status ACTIVE: ${setTerms.filter((t) => t.status === 'ACTIVE').length}`)
const setQ = new Set(setTerms.map((t) => t.term.trim().toLowerCase()))
console.log(`  of those ${setQ.size} terms: ${int([...setQ].filter((t) => sqpQ.has(t)).length)} have SQP rows · ${int([...setQ].filter((t) => paidQ.has(t)).length)} we have paid on`)

await prisma.$disconnect()
console.log('\n═══ end B ═══\n')
