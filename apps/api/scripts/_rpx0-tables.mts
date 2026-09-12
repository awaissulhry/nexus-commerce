import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT c.relname::text AS tbl, c.reltuples::bigint AS est
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND (c.relname ILIKE '%Brand%' OR c.relname ILIKE '%SearchQuery%' OR c.relname ILIKE '%Economics%'
      OR c.relname ILIKE '%Order%' OR c.relname ILIKE '%Sov%' OR c.relname ILIKE '%Coverage%'
      OR c.relname ILIKE '%Rank%' OR c.relname ILIKE '%Keyword%' OR c.relname ILIKE '%Amc%'
      OR c.relname ILIKE '%Stream%' OR c.relname ILIKE '%Sales%' OR c.relname ILIKE '%Market%')
  ORDER BY 1`)
for (const x of r) console.log(`${String(x.tbl).padEnd(46)} ~${Number(x.est)}`)
await prisma.$disconnect()
