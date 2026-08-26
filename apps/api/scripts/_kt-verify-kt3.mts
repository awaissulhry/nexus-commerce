/**
 * _kt-verify-kt3.mts — verify KT.5's Δ numbers and measure what KT.3's remaining columns can carry.
 *
 * Three questions, all read-only:
 *   A. Δ computability per market on the CURRENT watchlists (the garbled report said 96 of 116).
 *   B. The spend join: how many watchlist terms have exact-match paid traffic — in the last 30 days
 *      vs in the SAME WEEK the share column reads. This decides KT.3's spend window.
 *   C. Feed state right now: how many consecutive nights has sqp-ingest written zero?
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-kt3.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']

async function main() {
  // ── the watchlists KT.2 created ─────────────────────────────────────────
  h('0 · The watchlists in play')
  const wl = await (prisma as unknown as {
    keywordWatchlist: { findMany: (a: unknown) => Promise<Array<{ id: string; marketplace: string; name: string; isDefault: boolean; terms: Array<{ term: string; isBranded: boolean }> }>> }
  }).keywordWatchlist.findMany({ include: { terms: true } })
  const byMkt = new Map<string, { name: string; terms: string[]; branded: string[] }>()
  for (const w of wl) {
    if (!w.isDefault && byMkt.has(w.marketplace)) continue
    byMkt.set(w.marketplace, {
      name: w.name,
      terms: w.terms.filter((t) => !t.isBranded).map((t) => t.term.trim().toLowerCase()),
      branded: w.terms.filter((t) => t.isBranded).map((t) => t.term.trim().toLowerCase()),
    })
  }
  for (const m of MARKETS) {
    const w = byMkt.get(m)
    line(`${m}: ${w ? `"${w.name}" — ${w.terms.length} non-branded + ${w.branded.length} branded` : 'NO WATCHLIST'}`)
  }

  // ── all SQP rows for the watchlist terms ────────────────────────────────
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, searchQuery: true, asin: true, impressionShare: true },
  })
  const periodsByMkt = new Map<string, number[]>()
  for (const m of MARKETS) {
    periodsByMkt.set(m, [...new Set(sqp.filter((r) => r.marketplace === m).map((r) => +r.startDate))].sort((a, b) => b - a))
  }

  // reproduce the completeness gate: newest period whose row count >= 0.5 * median(trailing 4), within 42d
  const LOOKBACK = 42, RATIO = 0.5
  const now = Date.now()
  const chosen = new Map<string, { start: number; rows: number; truncated: boolean }>()
  for (const m of MARKETS) {
    const ps = periodsByMkt.get(m) ?? []
    const counts = new Map(ps.map((p) => [p, sqp.filter((r) => r.marketplace === m && +r.startDate === p).length]))
    const inWindow = ps.filter((p) => (now - p) / 864e5 <= LOOKBACK)
    let pick: { start: number; rows: number; truncated: boolean } | null = null
    for (const p of inWindow) {
      const idx = ps.indexOf(p)
      const trailing = ps.slice(idx + 1, idx + 5).map((x) => counts.get(x) ?? 0).sort((a, b) => a - b)
      const median = trailing.length ? (trailing.length % 2 ? trailing[(trailing.length - 1) / 2] : (trailing[trailing.length / 2 - 1] + trailing[trailing.length / 2]) / 2) : 0
      if ((counts.get(p) ?? 0) >= RATIO * median) { pick = { start: p, rows: counts.get(p) ?? 0, truncated: false }; break }
    }
    if (!pick) { const f = inWindow[0] ?? ps[0]; pick = f != null ? { start: f, rows: counts.get(f) ?? 0, truncated: true } : null as never }
    if (pick) chosen.set(m, pick)
  }
  h('1 · The period the gate picks, per market (reproduced)')
  for (const m of MARKETS) {
    const c = chosen.get(m)
    line(`${m}: ${c ? `${d10(new Date(c.start))} · ${c.rows} rows · ${Math.round((now - c.start) / 864e5)}d old${c.truncated ? ' · TRUNCATED (fallback)' : ''}` : 'no period'}`)
  }

  // ── A · Δ computability ─────────────────────────────────────────────────
  h('A · Δ computability — does an EARLIER period hold this term?')
  let totMeasured = 0, totDelta = 0
  for (const m of MARKETS) {
    const w = byMkt.get(m); const c = chosen.get(m)
    if (!w || !c) { line(`${m}: skipped`); continue }
    const ps = periodsByMkt.get(m) ?? []
    let measured = 0, withDelta = 0, noEarlier = 0
    const gaps = new Map<number, number>()
    for (const t of w.terms) {
      const here = sqp.some((r) => r.marketplace === m && +r.startDate === c.start && r.searchQuery.trim().toLowerCase() === t)
      if (!here) continue
      measured++
      const earlier = ps.filter((p) => p < c.start && sqp.some((r) => r.marketplace === m && +r.startDate === p && r.searchQuery.trim().toLowerCase() === t))
      if (!earlier.length) { noEarlier++; continue }
      withDelta++
      const gap = Math.round((c.start - earlier[0]) / 864e5)
      gaps.set(gap, (gaps.get(gap) ?? 0) + 1)
    }
    totMeasured += measured; totDelta += withDelta
    line(`${m}: measured ${measured} · Δ computable ${withDelta} · no earlier row ${noEarlier}`)
    line(`    gap distribution (days → terms): ${[...gaps.entries()].sort((a, b) => a[0] - b[0]).map(([g, n]) => `${g}d→${n}`).join(' · ') || '—'}`)
  }
  line(`TOTAL: ${totDelta} of ${totMeasured} measured rows could carry a Δ`)

  // ── B · The spend join ──────────────────────────────────────────────────
  h('B · Spend join — exact query text, two windows')
  const since30 = new Date(now - 30 * 864e5)
  const st30 = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'marketplace'],
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    where: { date: { gte: since30 } },
  })
  const m30 = new Map(st30.map((r) => [`${r.query.trim().toLowerCase()}|${r.marketplace}`, r]))
  for (const m of MARKETS) {
    const w = byMkt.get(m); const c = chosen.get(m)
    if (!w || !c) continue
    // same-week window: the 7 days starting at the chosen period
    const wkStart = new Date(c.start); const wkEnd = new Date(c.start + 7 * 864e5)
    const stWk = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query'], _sum: { costMicros: true, clicks: true, orders7d: true },
      where: { marketplace: m, date: { gte: wkStart, lt: wkEnd } },
    })
    const mWk = new Map(stWk.map((r) => [r.query.trim().toLowerCase(), r]))
    let in30 = 0, inWk = 0, neither = 0
    let spend30 = 0, spendWk = 0
    for (const t of w.terms) {
      const a = m30.get(`${t}|${m}`); const b = mWk.get(t)
      if (a) { in30++; spend30 += Number(a._sum.costMicros ?? 0n) / 1e6 }
      if (b) { inWk++; spendWk += Number(b._sum.costMicros ?? 0n) / 1e6 }
      if (!a && !b) neither++
    }
    line(`${m} (${w.terms.length} terms, share week ${d10(new Date(c.start))}):`)
    line(`    paid traffic in last 30d : ${in30} terms · €${spend30.toFixed(2)}`)
    line(`    paid traffic in THAT week: ${inWk} terms · €${spendWk.toFixed(2)}`)
    line(`    neither                  : ${neither} terms`)
  }

  // ── C · Feed state right now ────────────────────────────────────────────
  h('C · sqp-ingest — consecutive zero-yield nights')
  const runs = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 12 })
  let streak = 0; let counting = true
  for (const r of runs) {
    const zero = /rows=0\b/.test(r.outputSummary ?? '')
    const dur = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null
    line(`${new Date(r.startedAt).toISOString()} ${r.status.padEnd(8)} ${dur != null ? `${dur}s`.padStart(7) : '      —'}  ${r.outputSummary ?? ''}${r.errorMessage ? `  [err: ${r.errorMessage}]` : ''}`)
    if (counting) { if (zero || r.status !== 'SUCCESS') streak++; else counting = false }
  }
  line(`consecutive most-recent nights with no rows written (or non-SUCCESS): ${streak}`)
  const withErr = runs.filter((r) => r.status === 'SUCCESS' && r.errorMessage).length
  line(`of the last ${runs.length} runs, SUCCESS-while-carrying-an-error: ${withErr}`)
  const sqpMax = await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true, ingestedAt: true } })
  line(`latest SQP period ${sqpMax._max.startDate ? d10(sqpMax._max.startDate) : '—'} · last ingestedAt ${sqpMax._max.ingestedAt ? new Date(sqpMax._max.ingestedAt).toISOString() : '—'}`)

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
