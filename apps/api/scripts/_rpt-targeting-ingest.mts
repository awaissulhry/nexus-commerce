/** Poll the outstanding spTargeting jobs and ingest whatever has completed. */
const svc = await import('../src/services/advertising/ads-reports.service.js')
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
for (let i = 1; i <= 14; i++) {
  await svc.pollPendingJobs()
  const jobs = await p.amazonAdsReportJob.findMany({
    where: { reportTypeId: 'spTargeting' },
    select: { id: true, status: true, location: true, rowsIngested: true, errorMessage: true },
  })
  const done = jobs.filter(j => j.status === 'COMPLETED')
  const failed = jobs.filter(j => j.status === 'FAILED')
  console.log(`round ${i}: completed=${done.length} failed=${failed.length} pending=${jobs.length - done.length - failed.length}`)
  if (failed.length) console.log('   first failure:', failed[0].errorMessage?.slice(0, 300))
  for (const j of jobs.filter(x => x.location && x.rowsIngested === 0 && x.status !== 'FAILED')) {
    const out = await svc.ingestCompletedJob(j.id).catch(e => ({ error: (e as Error).message }))
    console.log('   ingest →', JSON.stringify(out))
  }
  if (done.length + failed.length === jobs.length) break
  await new Promise(r => setTimeout(r, 40000))
}
const n = await p.amazonAdsDailyPerformance.count({ where: { entityType: 'AD_TARGET' } })
console.log(`\nAD_TARGET rows: ${n.toLocaleString('en-GB')}`)
if (n > 0) {
  const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT d."marketplace" mkt, d.impressions imp, d.clicks,
           ROUND((d."costMicros"/1000000.0)::numeric,2) cost,
           ROUND((COALESCE(d."sales7dCents",0)/100.0)::numeric,2) sales,
           COALESCE(t.kind,'(unlinked)') kind, LEFT(COALESCE(t."expressionValue", d."entityId"),30) target
    FROM "AmazonAdsDailyPerformance" d LEFT JOIN "AdTarget" t ON t.id = d."localEntityId"
    WHERE d."entityType"='AD_TARGET' ORDER BY d."costMicros" DESC LIMIT 8`)
  for (const r of rows) console.log('  ', Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' '))
  const linked = await p.amazonAdsDailyPerformance.count({ where: { entityType: 'AD_TARGET', localEntityId: { not: null } } })
  console.log(`linked to local AdTarget: ${linked}/${n}`)
}
await p.$disconnect(); process.exit(0)
