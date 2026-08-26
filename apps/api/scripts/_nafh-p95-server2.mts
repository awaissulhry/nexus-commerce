import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const sample = await prisma.graphEdge.findMany({ where: { validTo: null }, take: 60, select: { fromType: true, fromId: true } })
const times: number[] = []
for (let i = 0; i < 100; i++) {
  const s = sample[i % sample.length]!
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN (ANALYZE, FORMAT TEXT)
    WITH RECURSIVE visit AS (
      SELECT $1::text AS type, $2::text AS id, 0 AS depth
      UNION
      SELECT nxt.type, nxt.id, v.depth + 1
      FROM visit v
      CROSS JOIN LATERAL (
        SELECT e."toType" AS type, e."toId" AS id FROM "GraphEdge" e
        WHERE e."validTo" IS NULL AND e."fromType" = v.type AND e."fromId" = v.id
        UNION ALL
        SELECT e."fromType", e."fromId" FROM "GraphEdge" e
        WHERE e."validTo" IS NULL AND e."toType" = v.type AND e."toId" = v.id
      ) nxt
      WHERE v.depth < 3
    ),
    vmin AS (SELECT type, id, MIN(depth) AS d FROM visit GROUP BY type, id)
    SELECT e."fromType", e."fromId", e."toType", e."toId", e."relation",
           (LEAST(vf.d, vt.d) + 1)::int AS depth
    FROM "GraphEdge" e
    JOIN vmin vf ON vf.type = e."fromType" AND vf.id = e."fromId"
    JOIN vmin vt ON vt.type = e."toType" AND vt.id = e."toId"
    WHERE e."validTo" IS NULL
    LIMIT 500`,
    s.fromType, s.fromId,
  )
  const line = rows.map(r => r['QUERY PLAN']).find(l => l.includes('Execution Time'))
  const ms = parseFloat(line?.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 'NaN')
  if (!Number.isNaN(ms)) times.push(ms)
}
times.sort((a, b) => a - b)
const p = (q: number) => times[Math.floor(times.length * q)]!
console.log(`frontier server-side over ${times.length} runs: p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${times[times.length-1]!.toFixed(1)}ms — acceptance <50ms: ${p(0.95) < 50 ? 'PASS' : 'FAIL'}`)
await prisma.$disconnect()
