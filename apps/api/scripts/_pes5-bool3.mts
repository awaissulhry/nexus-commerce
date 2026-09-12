import prisma from '../src/db.js'
const pats = ['"type":"boolean"', '"type": "boolean"', 'BOOLEAN']
for (const p of pats) {
  const r = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS n FROM "CategorySchema" WHERE to_jsonb("CategorySchema".*)::text LIKE '%${p}%'`).catch(() => [{ n: -1 }])
  console.log(`RESULT_pattern ${JSON.stringify(p)}: ${r[0]?.n}`)
}
const one = await prisma.$queryRawUnsafe<any[]>(
  `SELECT substring(to_jsonb("CategorySchema".*)::text from position('boolean' in to_jsonb("CategorySchema".*)::text) - 90 for 150) AS ctx
   FROM "CategorySchema" WHERE to_jsonb("CategorySchema".*)::text ILIKE '%boolean%' LIMIT 2`).catch(() => [])
for (const c of one) console.log('RESULT_context:', JSON.stringify(c.ctx).slice(0, 200))
await prisma.$disconnect()
