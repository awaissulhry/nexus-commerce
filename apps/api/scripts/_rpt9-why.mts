const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT LEFT(COALESCE("errorMessage",'(none)'), 46) err,
         COUNT(*)::int n,
         MIN(EXTRACT(DAY FROM NOW() - "completedAt"))::int min_age_days,
         MAX(EXTRACT(DAY FROM NOW() - "completedAt"))::int max_age_days
  FROM "AmazonAdsExportJob"
  WHERE "rowsIngested" = 0 AND "errorMessage" IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)
console.log('stranded jobs by error and age:')
for (const r of rows) console.log('  ', Object.entries(r).map(([k,v])=>`${k}=${v}`).join('  '))
const recent = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT (EXTRACT(DAY FROM NOW() - "completedAt"))::int age_days,
         COUNT(*)::int total,
         COUNT(*) FILTER (WHERE "rowsIngested" > 0)::int ingested
  FROM "AmazonAdsExportJob" WHERE "completedAt" > NOW() - INTERVAL '10 days'
  GROUP BY 1 ORDER BY 1`)
console.log('\nby age — how many ever ingested:')
for (const r of recent) console.log('  ', Object.entries(r).map(([k,v])=>`${k}=${v}`).join('  '))
await p.$disconnect(); process.exit(0)
