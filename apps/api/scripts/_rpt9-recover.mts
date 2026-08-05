/** Re-ingest export jobs stranded by the stale-URL bug, now that ingest re-mints. */
const { PrismaClient } = await import('@prisma/client')
const { ingestCompletedExport } = await import('../src/services/advertising/ads-v1-sync.service.js')
const p = new PrismaClient()
const LIMIT = Number(process.argv[2] ?? 60)
const before = await p.amazonAdsExportJob.count({ where: { errorMessage: { contains: 's3_download' }, rowsIngested: 0 } })
console.log(`stranded jobs with 0 rows: ${before}`)
const jobs = await p.amazonAdsExportJob.findMany({
  where: { status: 'COMPLETED', rowsIngested: 0, errorMessage: { contains: 's3_download' } },
  orderBy: { completedAt: 'desc' }, take: LIMIT, select: { id: true, resource: true },
})
let recovered = 0, rows = 0, failed = 0
const byResource: Record<string, number> = {}
for (const j of jobs) {
  const r = await ingestCompletedExport(j.id).catch(() => ({ rowsIngested: 0, error: 'threw' }))
  if (r.rowsIngested > 0) { recovered++; rows += r.rowsIngested; byResource[j.resource] = (byResource[j.resource] ?? 0) + r.rowsIngested }
  else failed++
}
console.log(`attempted ${jobs.length} · recovered ${recovered} · still failing ${failed} · rows restored ${rows.toLocaleString('en-GB')}`)
console.log('by resource:', JSON.stringify(byResource))
const after = await p.amazonAdsExportJob.count({ where: { errorMessage: { contains: 's3_download' }, rowsIngested: 0 } })
console.log(`stranded remaining: ${after}  (was ${before})`)
await p.$disconnect(); process.exit(0)
