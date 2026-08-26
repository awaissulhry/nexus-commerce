/**
 * _kt-verify-sqp3.mts — verify SQP.3's outcome, and size the four widening decisions (read-only).
 *
 *   A. The headline: is 2026-08-02 now the newest stored week, and how many rows?
 *   B. The KT page effect: which period does the completeness gate now pick per market, and what is
 *      the coverage denominator the reach line prints?
 *   C. The yield curve that changed SQP.3's own recommendation: rows per report per market.
 *   D. Migration state — the P3009 that blocked every session's deploys.
 *   E. The request ledger: is anything stuck?
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-sqp3.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']

async function main() {
  // ── A · the headline ─────────────────────────────────────────────────────
  h('A · The newest stored week')
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, searchQuery: true, asin: true, ingestedAt: true },
  })
  line(`SearchQueryPerformance rows: ${sqp.length}`)
  const weeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  line('week        IT     DE     ES     FR   total   distinct ASINs   first ingest')
  for (const w of weeks.slice(0, 6)) {
    const rs = sqp.filter((r) => +r.startDate === w)
    const per = MARKETS.map((m) => String(rs.filter((r) => r.marketplace === m).length).padStart(6)).join('')
    const asins = new Set(rs.map((r) => r.asin).filter(Boolean)).size
    const first = Math.min(...rs.map((r) => +r.ingestedAt))
    line(`${d10(new Date(w))}${per}  ${String(rs.length).padStart(6)}   ${String(asins).padStart(14)}   ${d10(new Date(first))}`)
  }
  const newest = weeks[0]
  line(`newest week: ${d10(new Date(newest))} — ${Math.round((Date.now() - newest) / 864e5)} days old`)

  // ── B · what the KT page now picks ───────────────────────────────────────
  h('B · The completeness gate, reproduced (ratio 0.5, lookback 42d)')
  const LOOKBACK = 42, RATIO = 0.5
  const now = Date.now()
  for (const m of MARKETS) {
    const ps = [...new Set(sqp.filter((r) => r.marketplace === m).map((r) => +r.startDate))].sort((a, b) => b - a)
    const counts = new Map(ps.map((p) => [p, sqp.filter((r) => r.marketplace === m && +r.startDate === p).length]))
    const inWin = ps.filter((p) => (now - p) / 864e5 <= LOOKBACK)
    let pick: { p: number; trunc: boolean } | null = null
    for (const p of inWin) {
      const i = ps.indexOf(p)
      const tr = ps.slice(i + 1, i + 5).map((x) => counts.get(x) ?? 0).sort((a, b) => a - b)
      const med = tr.length ? (tr.length % 2 ? tr[(tr.length - 1) / 2] : (tr[tr.length / 2 - 1] + tr[tr.length / 2]) / 2) : 0
      if ((counts.get(p) ?? 0) >= RATIO * med) { pick = { p, trunc: false }; break }
    }
    if (!pick && (inWin[0] ?? ps[0]) != null) pick = { p: inWin[0] ?? ps[0], trunc: true }
    const covered = pick ? new Set(sqp.filter((r) => r.marketplace === m && +r.startDate === pick!.p && r.asin).map((r) => r.asin)).size : 0
    line(`${m}: gate picks ${pick ? d10(new Date(pick.p)) : '—'} (${pick ? Math.round((now - pick.p) / 864e5) : '—'}d, ${pick ? counts.get(pick.p) : 0} rows${pick?.trunc ? ', TRUNCATED' : ''}) · ASINs measured in it: ${covered}`)
  }
  const ads = await prisma.adProductAd.findMany({ select: { asin: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } }, take: 6000 })
  for (const m of MARKETS) {
    const advertised = new Set(ads.filter((a) => a.adGroup?.campaign?.marketplace === m && a.asin).map((a) => a.asin)).size
    const everCovered = new Set(sqp.filter((r) => r.marketplace === m && r.asin).map((r) => r.asin)).size
    line(`  ${m}: advertised ASINs ${advertised} · covered ever ${everCovered}`)
  }

  // ── C · the yield curve ──────────────────────────────────────────────────
  h('C · Rows per report, per market — the 40x spread that changed the recommendation')
  try {
    const reqs = await (prisma as unknown as {
      sqpReportRequest: { findMany: (a?: unknown) => Promise<Array<Record<string, unknown>>> }
    }).sqpReportRequest.findMany({})
    line(`SqpReportRequest rows: ${reqs.length}`)
    const byStatus = new Map<string, number>()
    for (const r of reqs) byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1)
    line(`  by status: ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)
    const byMkt = new Map<string, { n: number; rows: number }>()
    for (const r of reqs) {
      const m = String(r.marketplace ?? '?')
      const e = byMkt.get(m) ?? { n: 0, rows: 0 }
      e.n++
      const rc = r.rowCount ?? r.rowsIngested ?? r.rows
      if (typeof rc === 'number') e.rows += rc
      byMkt.set(m, e)
    }
    for (const [m, e] of [...byMkt.entries()].sort()) {
      line(`  ${m}: ${e.n} requests · ${e.rows} rows · ${(e.rows / Math.max(1, e.n)).toFixed(2)} rows/report`)
    }
    const stuck = reqs.filter((r) => !['INGESTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'FATAL'].includes(String(r.status)))
    line(`  non-terminal (still outstanding): ${stuck.length}`)
  } catch (e) { line(`SqpReportRequest: ${(e as Error).message.slice(0, 90)}`) }

  // ── D · migration state (the P3009) ──────────────────────────────────────
  h('D · Migration state — the P3009 that blocked every session')
  const migs = await prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; applied_steps_count: number }>>(
    `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
     FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 8`,
  )
  for (const m of migs) {
    const state = m.rolled_back_at ? 'ROLLED BACK' : m.finished_at ? 'applied' : '🔴 UNFINISHED'
    line(`  ${state.padEnd(13)} ${m.migration_name} steps=${m.applied_steps_count}`)
  }
  const bad = migs.filter((m) => !m.finished_at && !m.rolled_back_at).length
  line(`unfinished migrations blocking deploys: ${bad}`)

  // ── E · the feed's own health, now ───────────────────────────────────────
  h('E · sqp-ingest and sqp-collect, last runs')
  for (const job of ['sqp-ingest', 'sqp-collect']) {
    const rs = await prisma.cronRun.findMany({ where: { jobName: job }, orderBy: { startedAt: 'desc' }, take: 4 })
    const total = await prisma.cronRun.count({ where: { jobName: job } })
    const first = await prisma.cronRun.findFirst({ where: { jobName: job }, orderBy: { startedAt: 'asc' } })
    const ageH = first ? (Date.now() - +first.startedAt) / 3600e3 : 0
    line(`${job}: ${total} runs since ${first ? new Date(first.startedAt).toISOString() : '—'} (${ageH.toFixed(1)}h → ${(total / Math.max(1, ageH / 24)).toFixed(1)}/day since it existed)`)
    for (const r of rs) {
      const dur = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null
      line(`   ${new Date(r.startedAt).toISOString()} ${r.status} ${dur != null ? `${dur}s` : '—'} ${(r.outputSummary ?? '').slice(0, 150)}${r.errorMessage ? ` [${r.errorMessage}]` : ''}`)
    }
  }

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
