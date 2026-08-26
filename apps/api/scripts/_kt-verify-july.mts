/**
 * _kt-verify-july.mts — did something break between 2026-07-12 and 07-19, or did the market shrink?
 *
 * SQP.5 brackets an event: the same IT ASINs went 42 terms → 25, and FR went 42 rows → 4, in the
 * same window. Before anyone hunts a defect, separate three explanations that look identical:
 *
 *   1. WE lost visibility        → our impressionsBrand fell against a flat market
 *   2. THE MARKET shrank         → impressionsTotal and searchQueryVolume fell too (seasonality)
 *   3. AMAZON REPORTS LESS       → fewer rows per ASIN with shares roughly unchanged
 *
 * Held constant: the SAME ASIN present in both weeks. That removes the coverage confound entirely.
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-july.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']

async function main() {
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: {
      marketplace: true, startDate: true, searchQuery: true, asin: true,
      searchQueryVolume: true, impressionsTotal: true, impressionsBrand: true, impressionShare: true,
    },
  })
  const weeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)

  // ── A · like-for-like: the SAME ASIN, consecutive weeks ──────────────────
  h('A · Same-ASIN, week-over-week — the confound removed')
  for (const m of MARKETS) {
    line(`${m}:`)
    line('  pair                        ASINs  queries/ASIN   mktVolume/ASIN   mktImpr/ASIN   ourImpr/ASIN   share')
    for (let i = 0; i + 1 < Math.min(weeks.length, 7); i++) {
      const [a, b] = [weeks[i], weeks[i + 1]]
      const rowsA = sqp.filter((r) => r.marketplace === m && +r.startDate === a)
      const rowsB = sqp.filter((r) => r.marketplace === m && +r.startDate === b)
      const asinsA = new Set(rowsA.map((r) => r.asin).filter(Boolean))
      const asinsB = new Set(rowsB.map((r) => r.asin).filter(Boolean))
      const both = [...asinsA].filter((x) => asinsB.has(x!))
      if (!both.length) { line(`  ${d10(new Date(a))} vs ${d10(new Date(b))}  — no common ASIN`); continue }
      const agg = (rows: typeof sqp, set: string[]) => {
        const f = rows.filter((r) => r.asin && set.includes(r.asin))
        const q = new Set(f.map((r) => r.searchQuery)).size
        const vol = f.reduce((s, r) => s + r.searchQueryVolume, 0)
        const ti = f.reduce((s, r) => s + r.impressionsTotal, 0)
        const bi = f.reduce((s, r) => s + r.impressionsBrand, 0)
        return { q, vol, ti, bi, n: set.length }
      }
      const A = agg(rowsA, both as string[]); const B = agg(rowsB, both as string[])
      const per = (x: number, n: number) => (n ? (x / n) : 0)
      const pct = (x: number, y: number) => (y ? `${(((x - y) / y) * 100).toFixed(0)}%` : '—')
      line(`  ${d10(new Date(a))} vs ${d10(new Date(b))}  ${String(both.length).padStart(5)}  `
        + `${per(A.q, A.n).toFixed(1)} vs ${per(B.q, B.n).toFixed(1)} (${pct(A.q, B.q)})  `
        + `${per(A.vol, A.n).toFixed(0)} vs ${per(B.vol, B.n).toFixed(0)} (${pct(A.vol, B.vol)})  `
        + `${per(A.ti, A.n).toFixed(0)} vs ${per(B.ti, B.n).toFixed(0)} (${pct(A.ti, B.ti)})  `
        + `${per(A.bi, A.n).toFixed(1)} vs ${per(B.bi, B.n).toFixed(1)} (${pct(A.bi, B.bi)})  `
        + `${A.ti ? ((A.bi / A.ti) * 100).toFixed(3) : '—'}% vs ${B.ti ? ((B.bi / B.ti) * 100).toFixed(3) : '—'}%`)
    }
  }

  // ── B · same QUERY, same ASIN — the market's own trajectory ──────────────
  h('B · Same query AND same ASIN across the July window — did the MARKET move?')
  const wA = weeks.find((w) => d10(new Date(w)) === '2026-08-02')
  const wB = weeks.find((w) => d10(new Date(w)) === '2026-07-12')
  if (wA && wB) {
    for (const m of MARKETS) {
      const key = (r: typeof sqp[number]) => `${r.searchQuery}|${r.asin}`
      const A = new Map(sqp.filter((r) => r.marketplace === m && +r.startDate === wA).map((r) => [key(r), r]))
      const B = new Map(sqp.filter((r) => r.marketplace === m && +r.startDate === wB).map((r) => [key(r), r]))
      const common = [...A.keys()].filter((k) => B.has(k))
      if (!common.length) { line(`${m}: no common query×ASIN between 12 Jul and 2 Aug`); continue }
      const sum = (mp: typeof A, f: (r: typeof sqp[number]) => number) => common.reduce((s, k) => s + f(mp.get(k)!), 0)
      const volA = sum(A, (r) => r.searchQueryVolume), volB = sum(B, (r) => r.searchQueryVolume)
      const tiA = sum(A, (r) => r.impressionsTotal), tiB = sum(B, (r) => r.impressionsTotal)
      const biA = sum(A, (r) => r.impressionsBrand), biB = sum(B, (r) => r.impressionsBrand)
      const d = (x: number, y: number) => (y ? `${(((x - y) / y) * 100).toFixed(0)}%` : '—')
      line(`${m}: ${common.length} common query×ASIN pairs`)
      line(`    market volume   12 Jul ${volB} → 2 Aug ${volA}  (${d(volA, volB)})`)
      line(`    market imprs    12 Jul ${tiB} → 2 Aug ${tiA}  (${d(tiA, tiB)})`)
      line(`    OUR imprs       12 Jul ${biB} → 2 Aug ${biA}  (${d(biA, biB)})`)
      line(`    our share       12 Jul ${tiB ? ((biB / tiB) * 100).toFixed(3) : '—'}% → 2 Aug ${tiA ? ((biA / tiA) * 100).toFixed(3) : '—'}%`)
    }
  }

  // ── C · the named ASINs ──────────────────────────────────────────────────
  h('C · The three ASINs SQP.5 named, week by week (IT)')
  for (const asin of ['B0BMSH19GY', 'B0BMSWM15B', 'B0BMSJWW7L']) {
    line(`${asin}:`)
    for (const w of weeks.slice(0, 7)) {
      const rows = sqp.filter((r) => r.marketplace === 'IT' && +r.startDate === w && r.asin === asin)
      if (!rows.length) { line(`   ${d10(new Date(w))}: absent`); continue }
      const ti = rows.reduce((s, r) => s + r.impressionsTotal, 0)
      const bi = rows.reduce((s, r) => s + r.impressionsBrand, 0)
      line(`   ${d10(new Date(w))}: ${String(rows.length).padStart(3)} queries · mktImpr ${String(ti).padStart(7)} · ourImpr ${String(bi).padStart(6)} · share ${ti ? ((bi / ti) * 100).toFixed(3) : '—'}%`)
    }
  }

  // ── D · listing status now, by market ────────────────────────────────────
  h('D · ChannelListing status by market — the other half of the event')
  const cl = await prisma.channelListing.groupBy({
    by: ['marketplace', 'listingStatus'], _count: { _all: true }, where: { channel: 'AMAZON' },
  }).catch(() => null)
  if (cl) {
    const byM = new Map<string, Map<string, number>>()
    for (const r of cl) {
      const m = r.marketplace ?? '(null)'
      if (!byM.has(m)) byM.set(m, new Map())
      byM.get(m)!.set(r.listingStatus ?? '(null)', r._count._all)
    }
    for (const [m, s] of [...byM.entries()].sort()) {
      line(`  ${m.padEnd(8)} ${[...s.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`)
    }
  }
  const upd = await prisma.channelListing.aggregate({ where: { channel: 'AMAZON' }, _min: { updatedAt: true }, _max: { updatedAt: true } }).catch(() => null)
  if (upd) line(`  ChannelListing.updatedAt range: ${upd._min.updatedAt ? d10(upd._min.updatedAt) : '—'} … ${upd._max.updatedAt ? d10(upd._max.updatedAt) : '—'}`)

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
