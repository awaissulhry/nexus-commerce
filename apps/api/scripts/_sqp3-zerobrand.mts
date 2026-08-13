/**
 * _sqp3-zerobrand.mts — 🔴 SQP.3: how many stored rows carry the ACR.0.2 parser bug?
 *
 * 4.1's oldest week showed 100 of 100 rows "differing" — but every difference was
 * `impressionsBrand 0 → 50`, `clicksBrand 0 → 3`. The stored value is ZERO and the fresh value is
 * real. That is not Amazon revising; it is `parseSqp`'s documented ACR.0.2 defect ("the 'our side'
 * counts were reading 0 on every one of 9,232 prod rows while the totals read 53.1M"), and
 * re-fetching REPAIRS it. `impressionShare` is derived from these, so every share on an affected row
 * is 0 too. READ-ONLY.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const d10 = (d: Date) => d.toISOString().slice(0, 10)

async function main() {
  const total = await prisma.searchQueryPerformance.count()
  // 🔴 impressionsTotal > 0 AND impressionsBrand = 0 is the signature. Spelled out rather than using
  // a NOT, and both branches counted so the complement is visible.
  const broken = await prisma.searchQueryPerformance.count({ where: { impressionsTotal: { gt: 0 }, impressionsBrand: 0 } })
  const good = await prisma.searchQueryPerformance.count({ where: { impressionsTotal: { gt: 0 }, impressionsBrand: { gt: 0 } } })
  const noTotal = await prisma.searchQueryPerformance.count({ where: { impressionsTotal: 0 } })
  h('the population')
  line(`SearchQueryPerformance rows: ${total}`)
  line(`  impressionsTotal > 0 AND impressionsBrand = 0  → ${broken}  🔴 the ACR.0.2 signature`)
  line(`  impressionsTotal > 0 AND impressionsBrand > 0  → ${good}`)
  line(`  impressionsTotal = 0                            → ${noTotal}`)
  line(`  sum ${broken + good + noTotal} vs ${total} ${broken + good + noTotal === total ? '✓ accounts for every row' : '🔴 does not add up'}`)

  h('by week — when does the bug stop?')
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], _count: { _all: true },
  })
  line(`${padr('week', 12)} ${pad('rows', 6)} ${pad('brand=0', 8)} ${pad('brand>0', 8)} ${pad('% broken', 9)} ${pad('ingested', 12)}`)
  for (const g of rows.sort((a, b) => +b.startDate - +a.startDate)) {
    const b = await prisma.searchQueryPerformance.count({ where: { startDate: g.startDate, impressionsTotal: { gt: 0 }, impressionsBrand: 0 } })
    const ok = await prisma.searchQueryPerformance.count({ where: { startDate: g.startDate, impressionsTotal: { gt: 0 }, impressionsBrand: { gt: 0 } } })
    const first = await prisma.searchQueryPerformance.findFirst({ where: { startDate: g.startDate }, orderBy: { ingestedAt: 'asc' }, select: { ingestedAt: true } })
    const pct = b + ok > 0 ? `${Math.round((b / (b + ok)) * 100)}%` : '—'
    line(`${padr(d10(g.startDate), 12)} ${pad(g._count._all, 6)} ${pad(b, 8)} ${pad(ok, 8)} ${pad(pct, 9)} ${pad(first ? d10(first.ingestedAt) : '—', 12)}`)
  }

  h('what it costs the page')
  line('impressionShare is stored as impressionsBrand / impressionsTotal, so a broken row has share 0.')
  const zeroShare = await prisma.searchQueryPerformance.count({ where: { impressionsTotal: { gt: 0 }, impressionShare: 0 } })
  line(`rows with impressionsTotal > 0 and impressionShare = 0: ${zeroShare}`)
  line(`⇒ ${broken} of those are the parser bug, not a real zero — and SOV.0 already recorded that`)
  line('  "a rounded 0.00% is not a zero". This is the other half: a STORED zero that was never real.')
  line()
  line('And sqpImpressionShareForAsins sums impressionsBrand/impressionsTotal over the latest week,')
  line('so any campaign whose latest week is a broken one reads a share of exactly 0 — indistinguishable')
  line('from "we have no presence" when the truth is "we never parsed our own presence".')

  h('control — a wrong field must throw')
  try {
    await (prisma.searchQueryPerformance as never as { count: (a: unknown) => Promise<number> }).count({ where: { impressionsBrandX: 0 } })
    line('🔴 no throw')
  } catch (e) { line(`✓ threw: ${String(e).slice(0, 60).replace(/\n/g, ' ')}`) }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
