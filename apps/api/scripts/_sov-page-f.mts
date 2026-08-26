/**
 * SOV.1 scoping — part F. READ-ONLY.
 *
 * SOV.1 adds two things to the shipped grid: a week-over-week Δ, and the funnel (click / cart-add
 * / purchase share). Neither is safe to specify without measuring:
 *
 *   1. The period gate picks ONE period per view. A Δ needs a comparable PRIOR period — one that
 *      (a) passes the completeness gate itself, (b) is not one of the pre-ACR.0.2 all-zero weeks,
 *      and (c) shares a population with the chosen week. If the query sets barely overlap, most
 *      rows cannot carry a Δ at all and the column is a promise the data cannot keep.
 *   2. The funnel columns are only worth building if clicksBrand / cartAddsBrand / purchasesBrand
 *      are actually populated. The ACR.0.2 parser defect zeroed OUR side of every stage; the fix
 *      landed, but only for weeks ingested after it.
 *
 * Also measures the real distribution of impression share, so SOV.1's colour scale is calibrated
 * against this account rather than against Pacvue's ~10% category ceiling.
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { chooseViewPeriod, KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS } =
  await import('../src/services/advertising/keyword-tracker.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`
const day = (d: Date) => d.toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

console.log('\n═══ SOV.1 scoping — Δ comparability and the funnel ═══\n')
console.log(`gate constants imported: lookback ${KT_LOOKBACK_DAYS}d · ratio ${SQP_COMPLETENESS_RATIO} · baseline ${SQP_BASELINE_PERIODS} periods\n`)

// ── 1. every period, per market, with its zero-ness ───────────────────────────
const all = await prisma.searchQueryPerformance.findMany({
  select: {
    marketplace: true, startDate: true, searchQuery: true, asin: true,
    impressionsBrand: true, impressionsTotal: true,
    clicksBrand: true, clicksTotal: true,
    cartAddsBrand: true, cartAddsTotal: true,
    purchasesBrand: true, purchasesTotal: true,
    searchQueryVolume: true,
  },
})
console.log(`SearchQueryPerformance rows: ${int(all.length)}\n`)

interface Per { rows: number; zeroImpr: number; anyClicks: number; anyCart: number; anyPurch: number; queries: Set<string> }
const per = new Map<string, Map<string, Per>>() // market -> period -> stats
for (const r of all) {
  const m = per.get(r.marketplace) ?? new Map<string, Per>()
  const k = day(r.startDate)
  const p = m.get(k) ?? { rows: 0, zeroImpr: 0, anyClicks: 0, anyCart: 0, anyPurch: 0, queries: new Set<string>() }
  p.rows++
  if (r.impressionsBrand === 0) p.zeroImpr++
  if (r.clicksBrand > 0) p.anyClicks++
  if (r.cartAddsBrand > 0) p.anyCart++
  if (r.purchasesBrand > 0) p.anyPurch++
  p.queries.add(r.searchQuery.trim().toLowerCase())
  m.set(k, p); per.set(r.marketplace, m)
}

console.log('── every period, per market. "allZero" = the pre-ACR.0.2 parser defect ──')
console.log(`${pad('mkt', 4)} ${pad('period', 11)} ${pad('rows', 6)} ${pad('queries', 8)} ${pad('imprBrand=0', 12)} ${pad('rows w/ clicks', 15)} ${pad('cart', 6)} ${pad('purch', 6)} flag`)
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  for (const [k, p] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const allZero = p.zeroImpr === p.rows
    console.log(`${pad(mk, 4)} ${pad(k, 11)} ${pad(int(p.rows), 6)} ${pad(int(p.queries.size), 8)} ${pad(`${int(p.zeroImpr)} (${Math.round((p.zeroImpr / p.rows) * 100)}%)`, 12)} ${pad(int(p.anyClicks), 15)} ${pad(int(p.anyCart), 6)} ${pad(int(p.anyPurch), 6)} ${allZero ? '🔴 ALL-ZERO' : ''}`)
  }
  console.log('')
}

// ── 2. what the gate picks at each ?weeks=, and what the prior comparable is ──
console.log('── the chosen period at each ?weeks=, and the nearest COMPARABLE prior ──')
console.log('   comparable = passes the same gate · not an all-zero week · exists\n')
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  const candidates = [...m.entries()].map(([k, p]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows: p.rows }))
  for (const weeks of [4, 8, 13] as const) {
    const chosen = chooseViewPeriod(candidates, { lookbackDays: weeks * 7 })
    if (!chosen.start) { console.log(`${pad(mk, 4)} weeks=${pad(String(weeks), 3)} → no period (${chosen.reason})`); continue }
    const chosenKey = day(chosen.start)
    const chosenP = m.get(chosenKey)!
    // the prior: the newest period strictly older than chosen that is not all-zero and clears the
    // SAME completeness threshold the gate used
    const priors = [...m.entries()]
      .filter(([k, p]) => k < chosenKey && p.zeroImpr !== p.rows && p.rows >= chosen.threshold)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    const prior = priors[0]
    if (!prior) { console.log(`${pad(mk, 4)} weeks=${pad(String(weeks), 3)} → ${chosenKey} · NO comparable prior`); continue }
    const [priorKey, priorP] = prior
    const overlap = [...chosenP.queries].filter((q) => priorP.queries.has(q)).length
    const gapDays = Math.round((+new Date(`${chosenKey}T00:00:00Z`) - +new Date(`${priorKey}T00:00:00Z`)) / 86_400_000)
    console.log(`${pad(mk, 4)} weeks=${pad(String(weeks), 3)} → chosen ${chosenKey} (${int(chosenP.queries.size)}q, thr ${Math.round(chosen.threshold)}) · prior ${priorKey} (${int(priorP.queries.size)}q) · gap ${gapDays}d · overlap ${int(overlap)} = ${p2(overlap / Math.max(1, chosenP.queries.size))} of chosen`)
  }
  console.log('')
}

// ── 3. is the funnel populated in the periods a view actually renders? ────────
console.log('── the funnel, in the DEFAULT view (weeks=8) only — the columns SOV.1 would add ──')
console.log(`${pad('mkt', 4)} ${pad('period', 11)} ${pad('queries', 8)} ${pad('impr>0', 8)} ${pad('clicks>0', 9)} ${pad('cart>0', 8)} ${pad('purch>0', 8)}`)
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  const candidates = [...m.entries()].map(([k, p]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows: p.rows }))
  const chosen = chooseViewPeriod(candidates, { lookbackDays: 8 * 7 })
  if (!chosen.start) continue
  const k = day(chosen.start)
  const rows = all.filter((r) => r.marketplace === mk && day(r.startDate) === k)
  const byQuery = new Map<string, { i: number; c: number; ca: number; p: number }>()
  for (const r of rows) {
    const q = r.searchQuery.trim().toLowerCase()
    const e = byQuery.get(q) ?? { i: 0, c: 0, ca: 0, p: 0 }
    e.i += r.impressionsBrand; e.c += r.clicksBrand; e.ca += r.cartAddsBrand; e.p += r.purchasesBrand
    byQuery.set(q, e)
  }
  const v = [...byQuery.values()]
  console.log(`${pad(mk, 4)} ${pad(k, 11)} ${pad(int(v.length), 8)} ${pad(int(v.filter((x) => x.i > 0).length), 8)} ${pad(int(v.filter((x) => x.c > 0).length), 9)} ${pad(int(v.filter((x) => x.ca > 0).length), 8)} ${pad(int(v.filter((x) => x.p > 0).length), 8)}`)
}

// ── 4. the real distribution of impression share, for the colour scale ────────
console.log('\n── impression-share distribution in the default views, for SOV.1\'s colour scale ──')
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  const candidates = [...m.entries()].map(([k, p]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows: p.rows }))
  const chosen = chooseViewPeriod(candidates, { lookbackDays: 8 * 7 })
  if (!chosen.start) continue
  const k = day(chosen.start)
  const rows = all.filter((r) => r.marketplace === mk && day(r.startDate) === k)
  const byQuery = new Map<string, { b: number; t: number }>()
  for (const r of rows) {
    const q = r.searchQuery.trim().toLowerCase()
    const e = byQuery.get(q) ?? { b: 0, t: 0 }
    e.b += r.impressionsBrand; e.t = Math.max(e.t, r.impressionsTotal)
    byQuery.set(q, e)
  }
  const shares = [...byQuery.values()].filter((x) => x.t > 0).map((x) => x.b / x.t).sort((a, b) => a - b)
  if (!shares.length) { console.log(`  ${mk} — no rows`); continue }
  const q = (f: number) => shares[Math.min(shares.length - 1, Math.floor(f * shares.length))]
  console.log(`  ${pad(mk, 4)} n=${pad(int(shares.length), 5)} min ${pad(p2(shares[0]), 8)} p50 ${pad(p2(q(0.5)), 8)} p90 ${pad(p2(q(0.9)), 8)} p99 ${pad(p2(q(0.99)), 8)} max ${p2(shares[shares.length - 1])}`)
  console.log(`         above 10%: ${int(shares.filter((s) => s > 0.10).length)} · above 5%: ${int(shares.filter((s) => s > 0.05).length)} · above 1%: ${int(shares.filter((s) => s > 0.01).length)} · below 0.01%: ${int(shares.filter((s) => s < 0.0001).length)}`)
}

await prisma.$disconnect()
console.log('\n═══ end F ═══\n')
