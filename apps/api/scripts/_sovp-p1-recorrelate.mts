import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(4) + '%'

// FIRST: is the market total really a property of the QUERY (max exact) or split per ASIN (sum)?
const weeks = (await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], orderBy: { startDate: 'desc' }, take: 3 })).map((w) => w.startDate)
const rows = await prisma.searchQueryPerformance.findMany({ where: { startDate: { in: weeks } }, select: { searchQuery: true, marketplace: true, asin: true, impressionsTotal: true, impressionsBrand: true, startDate: true } })
const g = new Map<string, number[]>()
const gb = new Map<string, number>()
for (const r of rows) {
  const k = `${r.marketplace}|${r.startDate.toISOString().slice(0,10)}|${(r.searchQuery||'').trim().toLowerCase()}`
  if (!g.has(k)) { g.set(k, []); gb.set(k, 0) }
  g.get(k)!.push(r.impressionsTotal ?? 0)
  gb.set(k, gb.get(k)! + (r.impressionsBrand ?? 0))
}
let disagree = 0, multi = 0, brandOverTotal = 0
for (const [k, tots] of g) {
  if (tots.length > 1) { multi++; if (new Set(tots).size > 1) disagree++ }
  if (gb.get(k)! > Math.max(...tots)) brandOverTotal++
}
console.log(`### DENOMINATOR SHAPE (latest 3 SQP weeks, ${rows.length} rows, ${g.size} query-weeks)`)
console.log(`  query-weeks with >1 ASIN row: ${multi}`)
console.log(`  of those, ASIN rows DISAGREEING about impressionsTotal: ${disagree}`)
console.log(`  query-weeks where Σbrand > max(total): ${brandOverTotal}`)
console.log(`  → MAX is ${disagree === 0 ? 'EXACT (the market total is a property of the query)' : 'NOT safe'}; SUM multiplies the denominator by the ASIN-row count`)

// Re-run the correlation with the CORRECT aggregation
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sov = await analyzeShareOfVoice({ windowDays: 30, limit: 100000 })
const engine = new Map(sov.rows.map((r) => [r.query.trim().toLowerCase(), r.sovPct]))
const agg = new Map<string, { brand: number; total: number }>()
for (const r of rows) {
  const k = `${r.marketplace}|${(r.searchQuery || '').trim().toLowerCase()}`
  const a = agg.get(k) ?? { brand: 0, total: 0 }
  a.brand += r.impressionsBrand ?? 0
  a.total = Math.max(a.total, r.impressionsTotal ?? 0)   // ← the page's own rule
  agg.set(k, a)
}
type Pair = { q: string; m: string; eng: number; real: number }
const pairs: Pair[] = []
for (const [k, a] of agg) {
  if (a.total <= 0) continue
  const [m, q] = k.split('|')
  const e = engine.get(q); if (e == null) continue
  pairs.push({ q, m, eng: e, real: a.brand / a.total })
}
const spearman = (xs: number[], ys: number[]) => {
  const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1; return r }
  const rx = rank(xs), ry = rank(ys), n = xs.length
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2 }
  return num / Math.sqrt(dx * dy)
}
console.log(`\n### CORRECTED RANK AGREEMENT (max denominator), ${pairs.length} market×query pairs`)
console.log(`  Spearman ρ pooled: ${spearman(pairs.map(p=>p.eng), pairs.map(p=>p.real)).toFixed(4)}`)
for (const m of [...new Set(pairs.map((p) => p.m))]) {
  const sub = pairs.filter((p) => p.m === m)
  if (sub.length < 8) { console.log(`  ${m}: only ${sub.length} pairs — not reported`); continue }
  console.log(`  ${m}: n=${sub.length}  ρ=${spearman(sub.map(p=>p.eng), sub.map(p=>p.real)).toFixed(4)}`)
}
console.log(`\n### CORRECTED head-query table`)
const top = sov.rows.slice(0, 8)
for (const r of top) {
  const hits = [...agg.entries()].filter(([k]) => k.endsWith(`|${r.query.trim().toLowerCase()}`))
  for (const [k, a] of hits) { if (a.total <= 0) continue
    console.log(`  ${k.split('|')[0]} "${r.query}"  engine=${pct(r.sovPct)}  real=${pct(a.brand/a.total)}  (${a.brand} / ${a.total})  overstated ${(r.sovPct/(a.brand/a.total)).toFixed(1)}x`) }
}
const byReal = pairs.slice().sort((a, b) => b.real - a.real)
console.log(`\n  TRUE strongest 5:`)
for (const p of byReal.slice(0, 5)) console.log(`    ${p.m} "${p.q}" real=${pct(p.real)} engine=${pct(p.eng)}`)
await prisma.$disconnect()
