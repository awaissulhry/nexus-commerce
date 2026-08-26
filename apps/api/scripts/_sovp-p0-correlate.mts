import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(4) + '%'

const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sov = await analyzeShareOfVoice({ windowDays: 30, limit: 100000 })
const engine = new Map(sov.rows.map((r) => [r.query.trim().toLowerCase(), r.sovPct]))

// SQP market share per query per market, latest 3 weeks unioned (rows are per ASIN → sum)
const weeks = (await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], orderBy: { startDate: 'desc' }, take: 3, _count: { _all: true } })).map((w) => w.startDate)
const sq = await prisma.searchQueryPerformance.findMany({ where: { startDate: { in: weeks } }, select: { searchQuery: true, marketplace: true, impressionsTotal: true, impressionsBrand: true } })
const agg = new Map<string, { brand: number; total: number }>()
for (const s of sq) {
  const k = `${s.marketplace}|${(s.searchQuery || '').trim().toLowerCase()}`
  const a = agg.get(k) ?? { brand: 0, total: 0 }
  a.brand += s.impressionsBrand ?? 0; a.total += s.impressionsTotal ?? 0
  agg.set(k, a)
}
console.log(`SQP weeks compared: ${weeks.map((w)=>w.toISOString().slice(0,10)).join(' ')} · rows ${sq.length}`)

// pair up: for each (market, query) with a real SQP total AND an engine sovPct
type Pair = { q: string; m: string; eng: number; real: number }
const pairs: Pair[] = []
for (const [k, a] of agg) {
  if (a.total <= 0) continue
  const [m, q] = k.split('|')
  const e = engine.get(q)
  if (e == null) continue
  pairs.push({ q, m, eng: e, real: a.brand / a.total })
}
console.log(`\noverlapping (market × query) pairs: ${pairs.length}`)

const spearman = (xs: number[], ys: number[]) => {
  const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1; return r }
  const rx = rank(xs), ry = rank(ys), n = xs.length
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2 }
  return num / Math.sqrt(dx * dy)
}
console.log(`\n### RANK AGREEMENT — does "Share of Voice" order queries the way real market share does?`)
console.log(`Spearman ρ (all pairs, both markets pooled): ${spearman(pairs.map(p=>p.eng), pairs.map(p=>p.real)).toFixed(4)}`)
for (const m of [...new Set(pairs.map((p) => p.m))]) {
  const sub = pairs.filter((p) => p.m === m)
  if (sub.length < 8) { console.log(`  ${m}: only ${sub.length} pairs — not reported`); continue }
  console.log(`  ${m}: n=${sub.length}  ρ=${spearman(sub.map(p=>p.eng), sub.map(p=>p.real)).toFixed(4)}`)
}
const ratios = pairs.filter((p) => p.real > 0).map((p) => p.eng / p.real).sort((a, b) => a - b)
console.log(`\noverstatement factor engine/real: median ${ratios[Math.floor(ratios.length/2)]?.toFixed(1)}×  min ${ratios[0]?.toFixed(2)}×  max ${ratios[ratios.length-1]?.toFixed(0)}×`)

// What a real rule would do: "SOV < 10% → raise bid". Which queries does it act on, and are they the weak ones?
console.log(`\n### WHAT THE RULE WOULD ACTUALLY DO — "Share of Voice < 10% → raise bid"`)
const fires = pairs.filter((p) => p.eng < 0.10)
const skips = pairs.filter((p) => p.eng >= 0.10)
const med = (a: number[]) => a.length ? a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)] : NaN
console.log(`  acts on ${fires.length}/${pairs.length} pairs; median REAL market share of those it acts on: ${pct(med(fires.map(p=>p.real)))}`)
console.log(`  skips   ${skips.length}/${pairs.length} pairs; median REAL market share of those it SKIPS:  ${pct(med(skips.map(p=>p.real)))}`)
console.log(`  → the queries it SKIPS are the ones we hold ${(med(skips.map(p=>p.real))/med(fires.map(p=>p.real))).toFixed(1)}× LESS/MORE of the market on`)

// the strongest and weakest real positions, and where the engine ranks them
const byReal = pairs.slice().sort((a, b) => b.real - a.real)
console.log(`\n  our TRUE strongest 5 positions (real market share) and the number a SOV rule would see:`)
for (const p of byReal.slice(0, 5)) console.log(`    ${p.m} "${p.q}" real=${pct(p.real)} engine=${pct(p.eng)}`)
console.log(`  our TRUE weakest 5 (real share, total>0):`)
for (const p of byReal.slice(-5)) console.log(`    ${p.m} "${p.q}" real=${pct(p.real)} engine=${pct(p.eng)}`)
await prisma.$disconnect()
