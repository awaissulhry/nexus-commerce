/** _sqp3-pick.mts — SQP.3: which (asin, week) pairs give 4.1 a strong field-by-field comparison? */
import '../src/env.js'
import prisma from '../src/db.js'
const d10 = (d: Date) => d.toISOString().slice(0, 10)
async function main() {
  const rows = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'asin', 'startDate'], _count: { _all: true } })
  const per = new Map<string, Array<{ week: string; n: number }>>()
  for (const r of rows) {
    if (!r.asin) continue
    const k = `${r.marketplace}|${r.asin}`
    const a = per.get(k) ?? []; a.push({ week: d10(r.startDate), n: r._count._all }); per.set(k, a)
  }
  // want: rows in a RECENT week AND a wide span AND high counts
  const scored = [...per.entries()].map(([k, ws]) => {
    const sorted = [...ws].sort((a, b) => b.week.localeCompare(a.week))
    const newest = sorted[0]
    return { k, weeks: sorted, span: ws.length, newestWeek: newest.week, newestN: newest.n, total: ws.reduce((a, w) => a + w.n, 0) }
  }).filter((x) => x.span >= 6)
  console.log('candidates with >=6 weeks, best newest-week coverage first:')
  for (const c of scored.sort((a, b) => b.newestN - a.newestN || b.total - a.total).slice(0, 8)) {
    const [mkt, asin] = c.k.split('|')
    console.log(`  ${mkt} ${asin} · span ${c.span} weeks · total ${c.total} rows · newest ${c.newestWeek} = ${c.newestN} rows`)
    console.log(`     ${c.weeks.slice(0, 8).map((w) => `${w.week}:${w.n}`).join(' · ')}`)
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0,200)); await prisma.$disconnect(); process.exit(1) })
