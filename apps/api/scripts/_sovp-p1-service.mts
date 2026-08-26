import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(2) + '%'
const { keywordMarketShares, sovShareKey } = await import('../src/services/advertising/ads-sov-keyword-share.service.js')

const res = await keywordMarketShares()
console.log('### THE GATE, PER MARKET')
for (const p of res.periods) {
  console.log(`  ${p.marketplace}: ${p.refused ? '🔴 REFUSED' : '✅ '} week=${p.start?.toISOString().slice(0,10) ?? '—'} age=${p.ageDays ?? '—'}d rows=${p.rows} baseline=${p.baselineRows} threshold=${p.threshold.toFixed(0)} reason=${p.reason} queries=${p.queries}`)
}
console.log(`measured markets: ${res.measuredMarkets.join(', ') || '(none)'}   total keyed rows: ${res.byKey.size}`)

// distribution — do operator thresholds now DISCRIMINATE?
const shares = [...res.byKey.values()].map((r) => r.sharePct).sort((a, b) => b - a)
const q = (p: number) => shares[Math.min(shares.length - 1, Math.floor(shares.length * p))]
console.log(`\n### DISTRIBUTION  n=${shares.length}`)
console.log(`  max=${pct(shares[0]??0)} p10=${pct(q(0.1))} p50=${pct(q(0.5))} p90=${pct(q(0.9))} min=${pct(shares[shares.length-1]??0)}`)
for (const t of [0.5, 0.2, 0.1, 0.05, 0.01]) {
  const n = shares.filter((s) => s < t).length
  console.log(`  "Share of Voice < ${(t*100).toFixed(0)}%" matches ${n}/${shares.length} (${pct(n/Math.max(1,shares.length))})`)
}

// coverage against the real target population
const targets = await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: false }, select: { id: true, status: true, expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } }, take: 3000 })
let hit = 0; const byM: Record<string, { hit: number; all: number }> = {}
for (const t of targets) {
  const m = t.adGroup?.campaign?.marketplace ?? '?'
  byM[m] = byM[m] ?? { hit: 0, all: 0 }; byM[m].all++
  if (res.byKey.has(sovShareKey(m, t.expressionValue))) { hit++; byM[m].hit++ }
}
console.log(`\n### TARGET COVERAGE  ${hit}/${targets.length} (${pct(hit/targets.length)})   [old wrong source: 1178 = 55.31%]`)
for (const [m, v] of Object.entries(byM)) console.log(`  ${m}: ${v.hit}/${v.all} (${pct(v.hit/Math.max(1,v.all))})`)

// enabled-only view — what a rule would really act on
const en = targets.filter((t) => t.status === 'ENABLED')
const enHit = en.filter((t) => res.byKey.has(sovShareKey(t.adGroup?.campaign?.marketplace, t.expressionValue))).length
console.log(`  ENABLED targets with a signal: ${enHit}/${en.length} (${pct(enHit/Math.max(1,en.length))})`)

// sanity: no fabricated zeros
console.log(`\n### NULL DISCIPLINE`)
console.log(`  rows with sharePct === 0 exactly: ${shares.filter((s)=>s===0).length}`)
console.log(`  rows with impressionsTotal <= 0: ${[...res.byKey.values()].filter((r)=>r.impressionsTotal<=0).length} (must be 0 — those are omitted, never zeroed)`)
console.log(`  rows with sharePct > 1: ${shares.filter((s)=>s>1).length} (must be 0)`)
console.log(`\n  sample:`)
for (const r of [...res.byKey.values()].sort((a,b)=>b.sharePct-a.sharePct).slice(0,5)) console.log(`    ${r.marketplace} "${r.query}" ${pct(r.sharePct)} (${r.impressionsBrand}/${r.impressionsTotal}, ${r.asinRows} ASIN rows)`)
await prisma.$disconnect()
