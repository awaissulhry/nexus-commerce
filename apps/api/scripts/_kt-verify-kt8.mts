/**
 * _kt-verify-kt8.mts — what KT.8 cost in coverage, and what it would take to get it back.
 *
 *   A. Per market: watchlist terms measured in the period the page now reads, vs the old one.
 *   B. ASINs requested nightly vs ASINs actually measured — the aim fix's yield.
 *   C. How terms-measured scales with ASINs-measured, across every stored week.
 *   D. The headroom question: what the nightly pass costs and what a raise would cost.
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-kt8.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']

async function main() {
  const wl = await (prisma as unknown as {
    keywordWatchlist: { findMany: (a: unknown) => Promise<Array<{ marketplace: string; name: string; isDefault: boolean; terms: Array<{ term: string; isBranded: boolean }> }>> }
  }).keywordWatchlist.findMany({ include: { terms: true } })
  const terms = new Map<string, string[]>()
  for (const w of wl) {
    if (!w.isDefault && terms.has(w.marketplace)) continue
    terms.set(w.marketplace, w.terms.filter((t) => !t.isBranded).map((t) => t.term.trim().toLowerCase()))
  }
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, searchQuery: true, asin: true },
  })
  const now = Date.now()

  // ── A · terms measured, per week ─────────────────────────────────────────
  h('A · Watchlist terms measured, per stored week')
  const weeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  for (const m of MARKETS) {
    const ts = new Set(terms.get(m) ?? [])
    line(`${m} — watchlist ${ts.size} non-branded terms`)
    for (const w of weeks.slice(0, 5)) {
      const rows = sqp.filter((r) => r.marketplace === m && +r.startDate === w)
      const asins = new Set(rows.map((r) => r.asin).filter(Boolean)).size
      const hit = new Set(rows.map((r) => r.searchQuery.trim().toLowerCase()).filter((q) => ts.has(q))).size
      line(`   ${d10(new Date(w))} (${String(Math.round((now - w) / 864e5)).padStart(2)}d): ${String(rows.length).padStart(5)} rows · ${String(asins).padStart(2)} ASINs · ${String(hit).padStart(3)} of ${ts.size} terms measured (${Math.round((hit / Math.max(1, ts.size)) * 100)}%)`)
    }
  }

  // ── B · the aim fix's yield ──────────────────────────────────────────────
  h('B · Requested vs measured — what the nightly pass buys')
  try {
    const reqs = await (prisma as unknown as {
      sqpReportRequest: { findMany: (a?: unknown) => Promise<Array<Record<string, unknown>>> }
    }).sqpReportRequest.findMany({})
    const byWeek = new Map<string, Map<string, number>>()
    for (const r of reqs) {
      const wk = String(r.startDate ?? r.periodStart ?? '?').slice(0, 10)
      const mk = String(r.marketplace ?? '?')
      if (!byWeek.has(wk)) byWeek.set(wk, new Map())
      byWeek.get(wk)!.set(mk, (byWeek.get(wk)!.get(mk) ?? 0) + 1)
    }
    line(`SqpReportRequest: ${reqs.length} rows`)
    for (const [wk, mm] of [...byWeek.entries()].sort().reverse().slice(0, 4)) {
      line(`  week ${wk}: ${[...mm.entries()].sort().map(([m, n]) => `${m}=${n} requested`).join(' · ')}`)
    }
    const cols = reqs.length ? Object.keys(reqs[0]) : []
    line(`  columns available: ${cols.join(', ')}`)
  } catch (e) { line(`SqpReportRequest: ${(e as Error).message.slice(0, 90)}`) }
  for (const m of MARKETS) {
    const newest = weeks[0]
    const rows = sqp.filter((r) => r.marketplace === m && +r.startDate === newest)
    const asins = new Set(rows.map((r) => r.asin).filter(Boolean)).size
    line(`  ${m} on ${d10(new Date(newest))}: 10 requested → ${asins} produced rows → ${rows.length} rows (${asins ? (rows.length / asins).toFixed(1) : '0'} rows/producing ASIN)`)
  }

  // ── C · how terms scale with ASINs ───────────────────────────────────────
  h('C · Terms measured vs ASINs measured — the scaling that decides the raise')
  for (const m of MARKETS) {
    const ts = new Set(terms.get(m) ?? [])
    const pts: Array<{ a: number; t: number; w: number }> = []
    for (const w of weeks) {
      const rows = sqp.filter((r) => r.marketplace === m && +r.startDate === w)
      if (!rows.length) continue
      const a = new Set(rows.map((r) => r.asin).filter(Boolean)).size
      const t = new Set(rows.map((r) => r.searchQuery.trim().toLowerCase()).filter((q) => ts.has(q))).size
      pts.push({ a, t, w })
    }
    const sorted = pts.sort((x, y) => x.a - y.a)
    line(`${m}: ${sorted.map((p) => `${p.a}a→${p.t}t`).join(' · ')}`)
    const best = sorted[sorted.length - 1]
    const cur = pts.find((p) => p.w === weeks[0])
    if (best && cur && best.a > cur.a) {
      line(`    at ${cur.a} ASINs the page measures ${cur.t} of ${ts.size} terms; the best observed week had ${best.a} ASINs and ${best.t} terms`)
    }
  }

  // ── D · what the nightly pass costs ──────────────────────────────────────
  h('D · Nightly cost and the last runs')
  for (const job of ['sqp-ingest', 'sqp-collect']) {
    const rs = await prisma.cronRun.findMany({ where: { jobName: job }, orderBy: { startedAt: 'desc' }, take: 3 })
    for (const r of rs) {
      const dur = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null
      line(`${job} ${new Date(r.startedAt).toISOString()} ${r.status} ${dur != null ? `${dur}s` : '—'} ${(r.outputSummary ?? '').slice(0, 170)}`)
    }
  }

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
