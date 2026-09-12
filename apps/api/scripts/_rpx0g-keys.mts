import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT k::text AS metric_key, COUNT(*)::int AS rows
  FROM "AmazonAdsBrandBuildingMetric", LATERAL jsonb_object_keys(metrics) k
  GROUP BY 1 ORDER BY 1`)
console.log(`${r.length} distinct keys`)
for (const x of r) console.log(`  ${String(x.metric_key).padEnd(52)} ${x.rows}`)
const s = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT jsonb_pretty(metrics) AS m FROM "AmazonAdsBrandBuildingMetric"
  WHERE marketplace='IT' AND "computationDate"='2026-08-15'
  ORDER BY LENGTH("categoryNodeName") ASC LIMIT 1`)
console.log('\n== IT root node, newest week, raw payload ==')
console.log(String(s[0]?.m ?? '').slice(0, 3000))
await prisma.$disconnect()
