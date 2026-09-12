/** READ-ONLY. GX.2 — walk the real tree and prove each level reconciles against its parent. */
import '../src/env.js'
const { hierarchyChildren } = await import('../src/services/advertising/ads-hierarchy.service.js')
const W = { from: '2026-07-01', to: '2026-08-25' }
const eur = (v: number | null | undefined) => (v == null ? '     —' : `€${v.toFixed(2).padStart(9)}`)
const line = (d: number, n: { label: string; sub: string | null; kind: string; metrics: Record<string, number | null>; expandable: boolean; href: string | null }) =>
  `${'   '.repeat(d)}${n.expandable ? '▾ ' : '  '}${n.label.slice(0, 34).padEnd(36 - d * 3)} ${eur(n.metrics.cost)}  acos ${n.metrics.acos == null ? '  —  ' : (n.metrics.acos * 100).toFixed(1).padStart(5) + '%'}  ${n.kind}${n.href ? '  ↗' : ''}`

const root = await hierarchyChildren({ level: 'root', parentId: null, ...W, decompose: 'product', marketplaces: ['IT'] })
console.log('ROOT'); for (const n of root.nodes) console.log(line(0, n))

const it = root.nodes[0]
const mk = await hierarchyChildren({ level: 'market', parentId: it.id, ...W, decompose: 'product', marketplaces: [] })
console.log(`\nMARKET ${it.label} — parent €${mk.parentMetrics?.cost?.toFixed(2)}`)
let sum = 0
for (const n of mk.nodes) { console.log(line(1, n)); sum += n.metrics.cost ?? 0 }
console.log(`   children sum €${sum.toFixed(2)}  →  ${Math.abs(sum - (mk.parentMetrics?.cost ?? 0)) < 0.02 ? '✓ EXACT' : '✗ MISMATCH'}`)

const pf = mk.nodes.sort((a, b) => (b.metrics.cost ?? 0) - (a.metrics.cost ?? 0))[0]
const camps = await hierarchyChildren({ level: 'portfolio', parentId: pf.id, ...W, decompose: 'product', marketplaces: [] })
console.log(`\nPORTFOLIO ${pf.label} — parent €${camps.parentMetrics?.cost?.toFixed(2)}  (${camps.nodes.length} campaigns)`)
let s2 = 0
for (const n of camps.nodes.slice(0, 4)) { console.log(line(2, n)); s2 += n.metrics.cost ?? 0 }
const allC = camps.nodes.reduce((t, n) => t + (n.metrics.cost ?? 0), 0)
console.log(`   children sum €${allC.toFixed(2)}  →  ${Math.abs(allC - (camps.parentMetrics?.cost ?? 0)) < 0.02 ? '✓ EXACT' : '✗ MISMATCH'}`)

const camp = camps.nodes.sort((a, b) => (b.metrics.cost ?? 0) - (a.metrics.cost ?? 0))[0]
for (const dec of ['product', 'target'] as const) {
  const kids = await hierarchyChildren({ level: 'campaign', parentId: camp.id, ...W, decompose: dec, marketplaces: [] })
  const real = kids.nodes.filter((n) => n.kind !== 'remainder')
  const rem = kids.nodes.find((n) => n.kind === 'remainder')
  const tot = kids.nodes.reduce((t, n) => t + (n.metrics.cost ?? 0), 0)
  console.log(`\nCAMPAIGN ${camp.label} → ${dec.toUpperCase()}S — parent €${kids.parentMetrics?.cost?.toFixed(2)}  (${real.length} ${dec}s)`)
  for (const n of real.slice(0, 3)) console.log(line(3, n))
  if (rem) console.log(line(3, rem))
  console.log(`   children + remainder = €${tot.toFixed(2)}  →  ${Math.abs(tot - (kids.parentMetrics?.cost ?? 0)) < 0.02 ? '✓ EXACT' : '✗ MISMATCH'}`)
  if (kids.remainder) console.log(`   remainder €${kids.remainder.amount} = ${(kids.remainder.pctOfParent * 100).toFixed(1)}% of parent`)
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
