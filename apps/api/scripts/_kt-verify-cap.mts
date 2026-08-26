import '../src/env.js'
import prisma from '../src/db.js'
const rows = await prisma.searchQueryPerformance.findMany({ select: { marketplace: true, startDate: true, asin: true } })
const per = new Map<string, number>()
for (const r of rows) { if (!r.asin) continue; const k = `${r.marketplace}|${+r.startDate}|${r.asin}`; per.set(k, (per.get(k) ?? 0) + 1) }
const counts = [...per.values()]
const hist = new Map<number, number>()
for (const c of counts) hist.set(c, (hist.get(c) ?? 0) + 1)
console.log(`distinct (market, week, ASIN) cells: ${counts.length}`)
console.log(`max queries in any cell: ${Math.max(...counts)}`)
console.log(`cells at exactly 100: ${hist.get(100) ?? 0}`)
console.log(`cells above 100: ${counts.filter((c) => c > 100).length}`)
console.log(`cells at 90-99: ${counts.filter((c) => c >= 90 && c < 100).length}`)
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
console.log(`most common cell sizes: ${top.map(([k, v]) => `${k}→${v}`).join(' · ')}`)
// per week: how many cells are AT the cap
const byWeek = new Map<string, { n: number; capped: number }>()
for (const [k, c] of per) { const w = k.split('|')[1]; const e = byWeek.get(w) ?? { n: 0, capped: 0 }; e.n++; if (c >= 100) e.capped++; byWeek.set(w, e) }
console.log('\nweek        cells  at-cap')
for (const [w, e] of [...byWeek.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 8)) {
  console.log(`${new Date(Number(w)).toISOString().slice(0,10)}  ${String(e.n).padStart(5)}  ${String(e.capped).padStart(6)}`)
}
await prisma.$disconnect()
