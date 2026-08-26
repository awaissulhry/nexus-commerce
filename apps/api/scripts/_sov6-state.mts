/**
 * SOV — where the page stands on 2026-08-16, before writing the next section's brief. READ-ONLY.
 *
 * Four days and three programmes (SQP.1–.3, AUTO.A7, the RT cursors) have landed under this page
 * since SOV.1 shipped. Everything the earlier briefs asserted about the data may have moved.
 * Re-measures only what would change the next brief:
 *
 *   1. SQP periods now — did the feed fix change which week the gate picks, and the staleness?
 *   2. Δ comparability now — the overlap that forced SOV.1's two-object design.
 *   3. Is a real zero reachable yet? (SOV.0 and SOV.1 both shipped unable to demonstrate one.)
 *   4. AdSpendCeiling — A7 shipped the ceiling SOV.7 was blocked on. What is configured?
 *   5. SOV_BID — still 0 rules? Is the context still wrong?
 *   6. The daily-cap counter — repaired, or still the brake that never trips?
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { chooseViewPeriod } = await import('../src/services/advertising/keyword-tracker.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`
const day = (d: Date) => d.toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

console.log('\n═══ SOV — state of the page, 2026-08-16 ═══\n')

// ── 1. the feed ───────────────────────────────────────────────────────────────
const rows = await prisma.searchQueryPerformance.findMany({
  select: { marketplace: true, startDate: true, searchQuery: true, impressionsBrand: true, impressionsTotal: true, clicksBrand: true, clicksTotal: true, reportPeriod: true },
})
console.log(`SearchQueryPerformance rows: ${int(rows.length)}`)
const periodKinds = new Map<string, number>()
for (const r of rows) periodKinds.set(r.reportPeriod, (periodKinds.get(r.reportPeriod) ?? 0) + 1)
console.log(`reportPeriod values: ${[...periodKinds].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  → SOV.1 §8 flagged reportPeriod as unguarded. If anything but WEEK appears, the gate can be fooled.`)

const per = new Map<string, Map<string, { rows: number; zero: number; queries: Set<string> }>>()
for (const r of rows) {
  const m = per.get(r.marketplace) ?? new Map()
  const k = day(r.startDate)
  const e = m.get(k) ?? { rows: 0, zero: 0, queries: new Set<string>() }
  e.rows++; if (r.impressionsBrand === 0) e.zero++
  e.queries.add(r.searchQuery.trim().toLowerCase())
  m.set(k, e); per.set(r.marketplace, m)
}
console.log(`\n── the six newest periods per market ──`)
console.log(`${pad('mkt', 4)} ${pad('period', 11)} ${pad('rows', 6)} ${pad('queries', 8)} allZero`)
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  for (const [k, e] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 6)) {
    console.log(`${pad(mk, 4)} ${pad(k, 11)} ${pad(int(e.rows), 6)} ${pad(int(e.queries.size), 8)} ${e.zero === e.rows ? '🔴 yes' : ''}`)
  }
  console.log('')
}
const newest = rows.reduce<Date | null>((a, r) => (!a || r.startDate > a ? r.startDate : a), null)
console.log(`newest stored period : ${newest ? day(newest) : '—'} · age ${newest ? Math.round((Date.now() - +newest) / 86_400_000) : '—'}d`)
const st = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
console.log(`ad feed latest date  : ${st ? day(st.date) : '—'} · age ${st ? Math.round((Date.now() - +st.date) / 86_400_000) : '—'}d`)

// ── 2. what the gate picks now, and Δ comparability ──────────────────────────
console.log(`\n── the gate's choice and the comparable prior, at ?weeks=8 (default) ──`)
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  const cands = [...m.entries()].map(([k, e]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows: e.rows }))
  const chosen = chooseViewPeriod(cands, { lookbackDays: 56 })
  if (!chosen.start) { console.log(`${pad(mk, 4)} no period (${chosen.reason})`); continue }
  const ck = day(chosen.start)
  const cq = m.get(ck)!.queries
  const priors = [...m.entries()].filter(([k, e]) => k < ck && e.zero !== e.rows && e.rows >= chosen.threshold).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  const prior = priors[0]
  if (!prior) { console.log(`${pad(mk, 4)} chosen ${ck} · NO comparable prior`); continue }
  const overlap = [...cq].filter((q) => prior[1].queries.has(q)).length
  console.log(`${pad(mk, 4)} chosen ${pad(ck, 11)} (${pad(int(cq.size), 5)}q) · prior ${pad(prior[0], 11)} (${pad(int(prior[1].queries.size), 5)}q) · overlap ${pad(int(overlap), 5)} = ${p2(overlap / Math.max(1, cq.size))}`)
}

// ── 3. is a real zero reachable yet? ─────────────────────────────────────────
console.log(`\n── a real zero (market total > 0, ours = 0) in the CHOSEN period of each market ──`)
for (const mk of MARKETS) {
  const m = per.get(mk); if (!m) continue
  const cands = [...m.entries()].map(([k, e]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows: e.rows }))
  const chosen = chooseViewPeriod(cands, { lookbackDays: 56 })
  if (!chosen.start) continue
  const k = day(chosen.start)
  const inP = rows.filter((r) => r.marketplace === mk && day(r.startDate) === k)
  const byQ = new Map<string, { b: number; t: number }>()
  for (const r of inP) {
    const q = r.searchQuery.trim().toLowerCase()
    const e = byQ.get(q) ?? { b: 0, t: 0 }
    e.b += r.impressionsBrand; e.t = Math.max(e.t, r.impressionsTotal); byQ.set(q, e)
  }
  const zeros = [...byQ.entries()].filter(([, v]) => v.b === 0 && v.t > 0)
  console.log(`  ${pad(mk, 4)} ${k} — ${zeros.length} real zeros${zeros.length ? ` · e.g. ${zeros.slice(0, 3).map(([q, v]) => `"${q}" (0 of ${int(v.t)})`).join(' · ')}` : ''}`)
}

// ── 4. the ceiling A7 shipped ────────────────────────────────────────────────
const ceilings = await prisma.adSpendCeiling.findMany()
console.log(`\n── AdSpendCeiling (AUTO.A7) : ${ceilings.length} rows ──`)
for (const c of ceilings) console.log(`  ${JSON.stringify(c)}`)

// ── 5. SOV_BID ───────────────────────────────────────────────────────────────
const sovRules = await prisma.automationRule.findMany({ where: { trigger: 'SOV_BID' }, select: { id: true, name: true, enabled: true, autonomyLevel: true } })
console.log(`\n── SOV_BID rules : ${sovRules.length} ──`)
for (const r of sovRules) console.log(`  ${r.name} enabled=${r.enabled} autonomy=${r.autonomyLevel}`)
const tg = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
const tgSpend = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, spendCents: { gt: 0 } } })
console.log(`  positive KEYWORD targets ${int(tg)} · with spendCents>0 ${int(tgSpend)}  ← the vacuous-guard check`)

// ── 6. the daily-cap counter ─────────────────────────────────────────────────
const capAll = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' } })
const cap7 = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } })
console.log(`\n── DAILY_CAP_EXCEEDED rows : all-time ${int(capAll)} · last 7d ${int(cap7)} ──`)
console.log(`  (7d > 0 means the cap counter now trips; 0 means it is still the brake that never engages)`)

await prisma.$disconnect()
console.log('\n═══ end ═══\n')
