// NAF.H — p95 measured SERVER-SIDE (EXPLAIN ANALYZE execution time):
// the workstation→Neon RTT (~40ms) is not part of the acceptance; the
// API runs in the same region as the DB.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const counts = await prisma.graphEdge.groupBy({
  by: ['relation'],
  where: { validTo: null },
  _count: { _all: true },
})
console.log('open edges by relation:', JSON.stringify(counts.map(c => `${c.relation}=${c._count._all}`)))

const sample = await prisma.graphEdge.findMany({
  where: { validTo: null },
  take: 60,
  select: { fromType: true, fromId: true },
})
const times: number[] = []
for (let i = 0; i < 100; i++) {
  const s = sample[i % sample.length]!
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN (ANALYZE, FORMAT TEXT)
    WITH RECURSIVE walk AS (
      SELECT e."fromType", e."fromId", e."toType", e."toId", e."relation", 1 AS depth
      FROM "GraphEdge" e
      WHERE e."validTo" IS NULL
        AND ((e."fromType" = $1 AND e."fromId" = $2) OR (e."toType" = $1 AND e."toId" = $2))
      UNION
      SELECT e."fromType", e."fromId", e."toType", e."toId", e."relation", w.depth + 1
      FROM "GraphEdge" e
      JOIN walk w ON (
           (e."fromType" = w."toType" AND e."fromId" = w."toId")
        OR (e."toType" = w."fromType" AND e."toId" = w."fromId")
        OR (e."fromType" = w."fromType" AND e."fromId" = w."fromId" AND NOT (e."toType" = w."toType" AND e."toId" = w."toId"))
        OR (e."toType" = w."toType" AND e."toId" = w."toId" AND NOT (e."fromType" = w."fromType" AND e."fromId" = w."fromId"))
      )
      WHERE e."validTo" IS NULL AND w.depth < 3
    )
    SELECT DISTINCT "fromType", "fromId", "toType", "toId", "relation", MIN(depth)::int AS depth
    FROM walk GROUP BY "fromType", "fromId", "toType", "toId", "relation" LIMIT 500`,
    s.fromType, s.fromId,
  )
  const line = rows.map(r => r['QUERY PLAN']).find(l => l.includes('Execution Time'))
  const ms = line ? parseFloat(line.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 'NaN') : NaN
  if (!Number.isNaN(ms)) times.push(ms)
}
times.sort((a, b) => a - b)
const p = (q: number) => times[Math.floor(times.length * q)]!
console.log(`server-side over ${times.length} runs: p50=${p(0.5).toFixed(2)}ms p95=${p(0.95).toFixed(2)}ms max=${times[times.length-1]!.toFixed(2)}ms — acceptance <50ms: ${p(0.95) < 50 ? 'PASS' : 'FAIL'}`)
await prisma.$disconnect()
