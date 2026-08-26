/** AX3 verification — the two things that must be true after the move. */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

// 1. A GUARDED reader must see exactly what it saw before — nothing it counted was removed.
//    Its figure is reproducible from the archive: guarded = (live now) and (live before - archive).
console.log('1. guarded readers unchanged — live now vs (live now + archive) - archive')
console.log(j(await q(`
  SELECT SUM("costMicros")::numeric/1000000 AS guarded_now
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "marketplace"='IT'
    AND "date" BETWEEN '2026-05-21' AND '2026-07-27'
    AND "reportRunId" IS DISTINCT FROM 'ams-stream'`)))
console.log(j(await q(`
  SELECT SUM("costMicros")::numeric/1000000 AS unguarded_now
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "marketplace"='IT'
    AND "date" BETWEEN '2026-05-21' AND '2026-07-27'`)))

// 2. The budget enforcer's own shape (ads-budget-enforce.service.ts:74), month by month.
//    Before: June read high by the duplicates in it. Now the two forms cannot differ.
console.log('\n2. the exposed budget-enforce read, by month — guarded vs unguarded')
console.log(j(await q(`
  SELECT to_char("date",'YYYY-MM') AS month,
         SUM("costMicros")::numeric/1000000 AS unguarded,
         SUM("costMicros") FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')::numeric/1000000 AS guarded
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "marketplace"='IT' AND "date" >= '2026-05-01'
  GROUP BY 1 ORDER BY 1`)))

// 3. What the duplicates HAD been adding, month by month — read from the archive.
console.log('\n3. what was removed, by month (from the archive)')
console.log(j(await q(`
  SELECT to_char("date",'YYYY-MM') AS month, COUNT(*)::int AS rows,
         SUM("costMicros")::numeric/1000000 AS cost
  FROM "AmazonAdsDailyPerformanceArchive" WHERE "archivedReason"='ams-daily-duplicate'
  GROUP BY 1 ORDER BY 1`)))

// 4. Nothing else on the table carries the marker, and no campaign-day lost its only row.
console.log('\n4. residue and coverage')
console.log(j(await q(`
  SELECT (SELECT COUNT(*)::int FROM "AmazonAdsDailyPerformance" WHERE "reportRunId"='ams-stream') AS marked_left,
         (SELECT COUNT(DISTINCT ("marketplace","date","entityId"))::int
          FROM "AmazonAdsDailyPerformanceArchive" a
          WHERE NOT EXISTS (SELECT 1 FROM "AmazonAdsDailyPerformance" r
            WHERE r."marketplace"=a."marketplace" AND r."date"=a."date"
              AND r."entityType"=a."entityType" AND r."entityId"=a."entityId")) AS orphaned_keys`)))
await prisma.$disconnect()

/**
 * Measured 2026-08-26 after the move, and recorded here because the answer is the honest one
 * rather than the dramatic one:
 *
 *   guarded vs unguarded, IT CAMPAIGN 2026-05-21..07-27 ....... EUR 3,282.57 both ways
 *   by month, guarded == unguarded ............................ every month
 *   removed ................... May 23 rows / EUR 0 · Jun 428 / EUR 1,248.35 · Jul 208 / EUR 69.01
 *   marked rows left in the live table ........................ 0
 *   archived keys with no surviving twin ...................... 0
 *
 * BEFORE the move, June's unguarded month-to-date for Italy read EUR 2,694.56 against a true
 * EUR 1,446.21 — **86% high** — and `ads-budget-enforce.service.ts:74` is that read.
 *
 * It never fired. `AdBudgetPlan` holds no rows at all for 2026-06; the single 2026-07 plan has
 * `autoPacing` and `stopOverSpend` both false, so the enforcer's own `where` never selected it;
 * and the four armed August plans sit in a month the duplicates (which stop on 27 July) never
 * reach. The months with duplicates and the months with armed plans do not overlap.
 *
 * So: a real defect that had not yet cost anything. The other 35 exposed reads were not traced
 * one by one — removing the rows is what makes that unnecessary.
 */
