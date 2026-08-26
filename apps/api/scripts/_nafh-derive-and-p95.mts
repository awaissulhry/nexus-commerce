// NAF.H — one-shot derivation on prod + the p95 acceptance measurement:
// depth-3 traversal p95 must come in under 50ms on production volume.
import '../src/env.js'
const { deriveAllEdges } = await import('../src/services/agent-fleet/graph-derivation.service.js')
const { traverse } = await import('../src/services/agent-fleet/graph-traversal.service.js')
const { default: prisma } = await import('../src/db.js')

const t0 = Date.now()
const summaries = await deriveAllEdges()
console.log('derivation:', JSON.stringify(summaries), `(${Date.now() - t0}ms)`)

const total = await prisma.graphEdge.count({ where: { validTo: null } })
console.log('open edges:', total)

// sample nodes across relations for a representative p95
const sample = await prisma.graphEdge.findMany({
  where: { validTo: null },
  take: 60,
  select: { fromType: true, fromId: true },
})
if (sample.length === 0) {
  console.log('NO EDGES — p95 not measurable')
} else {
  const times: number[] = []
  // warm-up (connection + plan cache)
  await traverse(sample[0]!.fromType, sample[0]!.fromId, { depth: 3 })
  for (let i = 0; i < 100; i++) {
    const s = sample[i % sample.length]!
    const t = Date.now()
    await traverse(s.fromType, s.fromId, { depth: 3 })
    times.push(Date.now() - t)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]!
  const p95 = times[Math.floor(times.length * 0.95)]!
  const max = times[times.length - 1]!
  console.log(`traversal depth-3 over ${sample.length} sampled nodes ×100 runs:`)
  console.log(`p50=${p50}ms p95=${p95}ms max=${max}ms — acceptance <50ms: ${p95 < 50 ? 'PASS' : 'FAIL'}`)
}
await prisma.$disconnect()
