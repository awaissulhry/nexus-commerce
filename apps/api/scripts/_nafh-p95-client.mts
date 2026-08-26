// client-side timing of the frontier traversal on prod volume
import '../src/env.js'
const { traverse } = await import('../src/services/agent-fleet/graph-traversal.service.js')
const { default: prisma } = await import('../src/db.js')
const sample = await prisma.graphEdge.findMany({ where: { validTo: null }, take: 60, select: { fromType: true, fromId: true } })
await traverse(sample[0]!.fromType, sample[0]!.fromId, { depth: 3 }) // warm
const times: number[] = []
for (let i = 0; i < 100; i++) {
  const s = sample[i % sample.length]!
  const t = Date.now()
  const edges = await traverse(s.fromType, s.fromId, { depth: 3 })
  times.push(Date.now() - t)
  if (i === 0) console.log('first result edges:', edges.length)
}
times.sort((a, b) => a - b)
const p = (q: number) => times[Math.floor(times.length * q)]!
console.log(`client-side (incl ~40ms RTT): p50=${p(0.5)}ms p95=${p(0.95)}ms max=${times[times.length-1]}ms`)
console.log(`net-of-RTT approximation: p95≈${p(0.95) - Math.min(...times)}ms over floor=${Math.min(...times)}ms`)
await prisma.$disconnect()
