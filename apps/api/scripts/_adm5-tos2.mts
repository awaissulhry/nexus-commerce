/** ADM.5 — where does Top-of-Search IS actually live, and is it fresh? */
import prisma from '../src/db.js'
for (const t of ['AmazonAdsPlacementReport', 'AmazonAdsDailyPerformance']) {
  try {
    const r = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*)::int rows, COUNT("topOfSearchIS")::int nonnull,
             MAX(date) FILTER (WHERE "topOfSearchIS" IS NOT NULL) AS last_nonnull, MAX(date) AS last_row
      FROM "${t}"`)
    console.log(`${t}: rows=${r[0].rows} tosNonNull=${r[0].nonnull} lastNonNull=${r[0].last_nonnull?.toISOString?.().slice(0,10)} lastRow=${r[0].last_row?.toISOString?.().slice(0,10)}`)
  } catch (e) { console.log(`${t}: ${(e as Error).message.slice(0,100)}`) }
}
console.log('\n=== placement report, last 10 days: TOP rows and how many carry IS ===')
const d = await prisma.$queryRawUnsafe<any[]>(`
  SELECT date, COUNT(*)::int rows, COUNT("topOfSearchIS")::int withis
  FROM "AmazonAdsPlacementReport" WHERE placement ILIKE '%Top of Search%' AND date > now() - interval '12 days'
  GROUP BY 1 ORDER BY 1 DESC`)
for (const r of d) console.log(`  ${r.date.toISOString().slice(0,10)} topRows=${String(r.rows).padStart(4)} withIS=${String(r.withis).padStart(4)} ${r.withis===0?'<-- none':''}`)

console.log('\n=== the ToS-IS ingest cron ===')
for (const j of ['ads-tos-is-ingest', 'ads-tos-is', 'tos-is-ingest', 'ads-report-create-pl']) {
  const runs = await prisma.cronRun.findMany({ where: { jobName: j }, orderBy: { startedAt: 'desc' }, take: 4, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
  if (!runs.length) continue
  console.log(`  -- ${j}`)
  for (const r of runs) console.log(`     ${r.startedAt.toISOString().slice(0,16)} ${String(r.status).padEnd(8)} ${r.outputSummary ?? ''} ${r.errorMessage ? '!! '+r.errorMessage.slice(0,90) : ''}`)
}
console.log('\n=== all cron job names containing tos/placement ===')
const names = await prisma.$queryRawUnsafe<any[]>(`SELECT DISTINCT "jobName" FROM "CronRun" WHERE "jobName" ILIKE '%tos%' OR "jobName" ILIKE '%placement%' OR "jobName" ILIKE '%pl%' ORDER BY 1`)
console.log('  ' + names.map(n=>n.jobName).join(', '))
await prisma.$disconnect()
