/**
 * Verify Amazon accepts the spTargeting column set BEFORE any cron is wired.
 * Creates ONE report for one day, polls it, ingests it. Read-mostly: the only
 * writes are the report job row and AmazonAdsDailyPerformance AD_TARGET rows.
 */
const svc = await import('../src/services/advertising/ads-reports.service.js')
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const DAY = process.argv[2] ?? '2026-07-28'
console.log(`creating spTargeting report for ${DAY}\n`)
const res = await svc.runTargetingReportCycle({ startDate: DAY, endDate: DAY })
console.log(`  created ${res.jobsCreated} · skipped ${res.jobsSkipped}`)
if (res.errors.length) { console.log('  ERRORS:'); res.errors.forEach(e => console.log('   ', e)) }
if (!res.jobsCreated && !res.jobsSkipped) { console.log('\nno jobs — stopping'); process.exit(1) }

for (let i = 1; i <= 20; i++) {
  await new Promise(r => setTimeout(r, 15000))
  const polled = await svc.pollPendingJobs()
  const jobs = await p.amazonAdsReportJob.findMany({
    where: { reportTypeId: 'spTargeting', startDate: new Date(`${DAY}T00:00:00Z`) },
    select: { id: true, status: true, errorMessage: true, rowsIngested: true, location: true },
  })
  const st = jobs.map(j => j.status).join(',')
  console.log(`  poll ${i}: ${JSON.stringify(polled)} · statuses=${st}`)
  if (jobs.some(j => j.status === 'FAILED')) {
    console.log('\n  FAILED:', jobs.find(j => j.status === 'FAILED')?.errorMessage?.slice(0, 400)); break
  }
  if (jobs.every(j => j.status === 'COMPLETED')) { console.log('\n  all COMPLETED'); break }
  if (jobs.some(j => j.location)) {
    for (const j of jobs.filter(x => x.location)) {
      const out = await svc.ingestCompletedJob(j.id).catch(e => ({ error: (e as Error).message }))
      console.log('  ingest →', JSON.stringify(out))
    }
  }
}
const n = await p.amazonAdsDailyPerformance.count({ where: { entityType: 'AD_TARGET' } })
console.log(`\nAD_TARGET rows now in AmazonAdsDailyPerformance: ${n.toLocaleString('en-GB')}`)
if (n > 0) {
  const sample = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT d."entityId", d."marketplace", d.impressions, d.clicks,
           ROUND((d."costMicros"/1000000.0)::numeric,2) cost,
           ROUND((COALESCE(d."sales7dCents",0)/100.0)::numeric,2) sales,
           t.kind, LEFT(COALESCE(t."expressionValue",'—'),34) target
    FROM "AmazonAdsDailyPerformance" d
    LEFT JOIN "AdTarget" t ON t.id = d."localEntityId"
    WHERE d."entityType"='AD_TARGET' ORDER BY d."costMicros" DESC LIMIT 6`)
  console.log('top targets by spend:')
  for (const r of sample) console.log('  ', Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' '))
  const linked = await p.amazonAdsDailyPerformance.count({ where: { entityType: 'AD_TARGET', localEntityId: { not: null } } })
  console.log(`linked to a local AdTarget: ${linked}/${n}`)
}
await p.$disconnect(); process.exit(0)
