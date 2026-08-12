/**
 * _sov0-zerowhy.mts — why the rendered week holds no zeros (read-only).
 *
 * `_sov0-zero.mts` §4 shows IT 2026-07-12 with 88 zero rows of 1,066 and IT 2026-07-19 — the week
 * the gate renders — with 0 of 655. A discontinuity that sharp is either a real market fact or a
 * property of what the ingest wrote that week. It decides whether the "we hold none" cell is
 * untriggered-today or unreachable-by-construction, and those need different sentences.
 *
 * Also separates the weeks where 100% of rows are zero — those are the pre-ACR.0.2 parser defect
 * (`sqp.service.ts` header: "our side counts read 0 on every one of 9,232 rows"), not absence.
 *
 * NO WRITES. Run from apps/api.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
async function main() {
  for (const [m, ...ps] of [['IT', '2026-07-19', '2026-07-12', '2026-07-05'], ['DE', '2026-07-19', '2026-07-12'], ['ES', '2026-07-12', '2026-06-14']] as const) {
    for (const p of ps) {
      const start = new Date(`${p}T00:00:00Z`)
      const agg = await prisma.searchQueryPerformance.aggregate({
        where: { marketplace: m, startDate: start },
        _min: { impressionsBrand: true, impressionsTotal: true }, _max: { impressionsBrand: true }, _count: { _all: true },
      })
      const buckets = await Promise.all([1, 2, 3, 5, 10].map((n) =>
        prisma.searchQueryPerformance.count({ where: { marketplace: m, startDate: start, impressionsBrand: { lte: n } } })))
      const ingest = await prisma.searchQueryPerformance.aggregate({ where: { marketplace: m, startDate: start }, _min: { ingestedAt: true }, _max: { ingestedAt: true } })
      line(`${m} ${p}: rows=${agg._count._all} brand min=${agg._min.impressionsBrand} max=${agg._max.impressionsBrand} · total min=${agg._min.impressionsTotal}`)
      line(`    rows with brand ≤ 1/2/3/5/10: ${buckets.join(' / ')}`)
      line(`    ingestedAt ${ingest._min.ingestedAt?.toISOString().slice(0, 16)} → ${ingest._max.ingestedAt?.toISOString().slice(0, 16)}`)
    }
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
