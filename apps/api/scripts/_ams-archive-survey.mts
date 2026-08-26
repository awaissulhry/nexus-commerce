/** AX3 survey — read-only. Exactly what carries the AMS daily marker, before anything moves. */
const { default: prisma } = await import('../src/db.js')

const q = <T,>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x), 1)

console.log('── the marked set ──')
console.log(j(await q(`
  SELECT COUNT(*)::int AS rows,
         MIN("date")::text AS first_day, MAX("date")::text AS last_day,
         COUNT(DISTINCT "marketplace")::int AS markets,
         COUNT(DISTINCT "entityType"::text)::int AS entity_types,
         SUM("costMicros")::numeric / 1000000.0 AS cost,
         COUNT(*) FILTER (WHERE "localEntityId" IS NULL)::int AS null_local,
         MAX("createdAt")::text AS newest_write
  FROM "AmazonAdsDailyPerformance" WHERE "reportRunId" = 'ams-stream'`)))

console.log('── by marketplace x entityType ──')
console.log(j(await q(`
  SELECT "marketplace", "entityType"::text AS entity_type, COUNT(*)::int AS rows,
         SUM("costMicros")::numeric / 1000000.0 AS cost
  FROM "AmazonAdsDailyPerformance" WHERE "reportRunId" = 'ams-stream'
  GROUP BY 1, 2 ORDER BY 3 DESC`)))

console.log('── is each marked row a DUPLICATE of a real report row for the same key? ──')
console.log(j(await q(`
  SELECT COUNT(*)::int AS marked,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM "AmazonAdsDailyPerformance" r
           WHERE r."reportRunId" IS DISTINCT FROM 'ams-stream'
             AND r."marketplace" = a."marketplace" AND r."date" = a."date"
             AND r."entityType" = a."entityType" AND r."entityId" = a."entityId"
         ))::int AS has_report_twin
  FROM "AmazonAdsDailyPerformance" a WHERE a."reportRunId" = 'ams-stream'`)))

console.log('── would deleting them lose a campaign-day nothing else covers? ──')
console.log(j(await q(`
  SELECT a."marketplace", a."date"::text AS day, a."entityId", a."costMicros"::numeric/1000000.0 AS cost
  FROM "AmazonAdsDailyPerformance" a
  WHERE a."reportRunId" = 'ams-stream' AND NOT EXISTS (
    SELECT 1 FROM "AmazonAdsDailyPerformance" r
    WHERE r."reportRunId" IS DISTINCT FROM 'ams-stream'
      AND r."marketplace" = a."marketplace" AND r."date" = a."date"
      AND r."entityType" = a."entityType" AND r."entityId" = a."entityId")
  ORDER BY a."date" LIMIT 25`)))

console.log('── null reportRunId rows (the IS DISTINCT FROM case) ──')
console.log(j(await q(`
  SELECT COUNT(*)::int AS null_run_id FROM "AmazonAdsDailyPerformance" WHERE "reportRunId" IS NULL`)))

await prisma.$disconnect()
