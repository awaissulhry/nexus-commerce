/**
 * _sov6-handoff.mts — the three numbers the SQP and KT owners need, and nothing else (read-only).
 *
 * SOV.6 owns making the page's refusal visible. It does NOT own the two causes underneath, and
 * this probe exists so neither owner has to re-derive anything:
 *
 *   1. THE ASIN SERIES — distinct ASINs and rows per period per market, so the narrowing is
 *      visible as a trend rather than one comparison, plus WHICH ASINs dropped out.  → the SQP owner
 *   2. THE THRESHOLD CONSEQUENCE — how many of the last N periods pass at the shipped ratio, and
 *      how the answer moves at 0.4 and 0.3. Presented, NOT acted on: `SQP_COMPLETENESS_RATIO` is
 *      shared with Keyword Tracker, which shows different data for its own reasons. → KT / substrate
 *   3. THE BEST ACHIEVABLE AGE — the ingest requests a completed period with a lookback, so even a
 *      perfect week cannot be current. States whether this is a 14-day problem or a 28-day one.
 *
 * NO WRITES. Run from apps/api.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function main() {
  h('1 · the ASIN series — the CAUSE, as a trend')
  for (const m of MARKETS) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m }, select: { startDate: true, asin: true },
    })
    const byPeriod = new Map<number, { rows: number; asins: Set<string> }>()
    for (const r of rows) {
      const k = +r.startDate
      const e = byPeriod.get(k) ?? { rows: 0, asins: new Set<string>() }
      e.rows++; if (r.asin) e.asins.add(r.asin); byPeriod.set(k, e)
    }
    const series = [...byPeriod.entries()].sort((a, b) => b[0] - a[0]).slice(0, 10)
    line(`${m}: ${series.map(([k, v]) => `${d10(new Date(k)).slice(5)}=${v.asins.size}a/${v.rows}r`).join('  ')}`)
    // which ASINs the newest period lost against the one the gate renders
    if (series.length >= 2) {
      const newest = series[0][1].asins
      const older = series.find(([, v]) => v.rows > 200)?.[1].asins ?? series[1][1].asins
      const dropped = [...older].filter((a) => !newest.has(a))
      const gained = [...newest].filter((a) => !older.has(a))
      line(`    newest period lost ${dropped.length} ASIN(s): ${dropped.slice(0, 8).join(', ') || '—'}${dropped.length > 8 ? ' …' : ''}`)
      if (gained.length) line(`    and gained ${gained.length}: ${gained.slice(0, 5).join(', ')}`)
    }
  }

  h(`2 · the threshold consequence — at the shipped ratio ${SQP_COMPLETENESS_RATIO}, and at 0.4 / 0.3`)
  line('   (presented, NOT acted on — the constant is shared with Keyword Tracker)')
  for (const m of MARKETS) {
    const g = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    const periods = g.map((x) => ({ start: x.startDate, rows: x._count._all }))
    const baseline = median(periods.slice(0, SQP_BASELINE_PERIODS).map((p) => p.rows))
    const last8 = periods.slice(0, 8)
    const pass = (ratio: number) => last8.filter((p) => p.rows >= ratio * baseline).length
    line(`${m}: baseline(${SQP_BASELINE_PERIODS}) ${baseline} · of the last ${last8.length} periods, PASS at `
      + `0.5 → ${pass(0.5)} · 0.4 → ${pass(0.4)} · 0.3 → ${pass(0.3)}`)
    const newest = last8[0]
    line(`    newest ${d10(newest.start)} (${newest.rows} rows) needs ${Math.round(0.5 * baseline)} at 0.5 · `
      + `${Math.round(0.4 * baseline)} at 0.4 · ${Math.round(0.3 * baseline)} at 0.3 → `
      + `${[0.5, 0.4, 0.3].map((r) => `${r}:${newest.rows >= r * baseline ? 'PASS' : 'fail'}`).join(' ')}`)
  }

  h('3 · can this page ever be current? the feed\'s best achievable age')
  {
    const newest = await prisma.searchQueryPerformance.findFirst({ orderBy: { startDate: 'desc' }, select: { startDate: true, ingestedAt: true } })
    const ads = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
    const now = Date.now()
    const age = (d: Date) => Math.floor((now - +d) / 86_400_000)
    line(`newest SQP period ${d10(newest!.startDate)} · age ${age(newest!.startDate)}d · first ingested ${newest!.ingestedAt.toISOString().slice(0, 16)}`)
    line(`ad feed newest    ${d10(ads!.date)} · age ${age(ads!.date)}d`)
    // A weekly period is only requestable once complete; the row is dated at the period START.
    line('')
    line('  A weekly period is dated at its START and is only requestable once the week has CLOSED,')
    line('  so a period start is already 7 days old the moment it becomes eligible. Amazon then needs')
    line(`  a few days to finalise it: 2026-08-02 closed on 08-08 and first landed ${Math.floor((+newest!.ingestedAt - +newest!.startDate) / 86_400_000)} days after its start.`)
    line('  → even a week that PASSED the gate the day it landed would render at that age.')
    line(`  → so this is structurally a ~${Math.floor((+newest!.ingestedAt - +newest!.startDate) / 86_400_000)}-day floor, and today's 27d is that floor PLUS the`)
    line('    two rejected weeks. Fixing the ASIN coverage removes the second part, not the first.')
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
