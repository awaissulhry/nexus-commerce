/** ACR.2.2b — the position-weighted scoreboard against prod. READ-ONLY. */
import '../src/env.js'
await import('../src/db.js')
const { getCoverageScoreboard } = await import('../src/services/advertising/ads-coverage.service.js')

const b = await getCoverageScoreboard({ marketplace: 'IT', limit: 200 })
const pct = (v: number | null, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)

console.log(`\n═══ IT · week ${b.week} · measured=${b.measured} ═══`)
console.log(`pooled share ${pct(b.totals.share)} · pooled position-weighted ${pct(b.pwTotal)}`)
const w = b.positionWeight
console.log(`position weight: rest-of-search is worth ${pct(w.restWeight, 1)} of a top slot (${w.basis})`)
console.log(`  top CTR ${pct(w.topCtr, 3)} on ${w.topImpressions.toLocaleString()} impr · rest CTR ${pct(w.restCtr, 3)} on ${w.restImpressions.toLocaleString()} impr · ${w.windowDays}d`)
console.log(`ToS-IS measured: ${b.tosIsMeasured}`)
for (const n of b.notes) console.log(`  · ${n}`)

const basis = new Map<string, number>()
for (const r of b.rows) basis.set(r.positionBasis, (basis.get(r.positionBasis) ?? 0) + 1)
console.log(`\nposition basis across ${b.rows.length} rows: ${[...basis.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`)

console.log(`\n${'term'.padEnd(32)} ${'market'.padStart(9)} ${'share'.padStart(7)} ${'top mix'.padStart(8)} ${'pw score'.padStart(9)} ${'ToS-IS'.padStart(7)}  basis`)
for (const r of b.rows.slice(0, 22)) {
  console.log(`${r.term.slice(0, 30).padEnd(32)} ${r.marketImpressions.toLocaleString().padStart(9)} ${pct(r.share).padStart(7)} ${pct(r.topMix, 0).padStart(8)} ${pct(r.pwScore).padStart(9)} ${pct(r.tosIS).padStart(7)}  ${r.positionBasis}`)
}

console.log('\n── where position CHANGES the ranking (share order vs pw order) ──')
const byShare = [...b.rows].filter((r) => r.pwScore != null).sort((a, c) => (c.share ?? 0) - (a.share ?? 0))
const byPw = [...byShare].sort((a, c) => (c.pwScore ?? 0) - (a.pwScore ?? 0))
for (let i = 0; i < Math.min(10, byPw.length); i++) {
  const moved = byShare.findIndex((x) => x.term === byPw[i]!.term) - i
  console.log(`  ${String(i + 1).padStart(2)}. ${byPw[i]!.term.slice(0, 30).padEnd(32)} pw=${pct(byPw[i]!.pwScore)} share=${pct(byPw[i]!.share)} topMix=${pct(byPw[i]!.topMix, 0)}  ${moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '='}`)
}

const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
