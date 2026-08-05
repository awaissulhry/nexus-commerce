const { PrismaClient } = await import('@prisma/client')
const { ingestCompletedExport } = await import('../src/services/advertising/ads-v1-sync.service.js')
const p = new PrismaClient()
const jobs = await p.amazonAdsExportJob.findMany({
  where: { status: 'COMPLETED', rowsIngested: 0, errorMessage: { contains: 's3_download' } },
  orderBy: { completedAt: 'desc' }, take: 6,
  select: { id: true, resource: true, profileId: true, externalExportId: true, completedAt: true },
})
for (const j of jobs) {
  const ageH = j.completedAt ? Math.round((Date.now() - j.completedAt.getTime()) / 3600000) : null
  const r = await ingestCompletedExport(j.id).catch(e => ({ rowsIngested: 0, error: (e as Error).message }))
  console.log(`RESULT ${j.resource.padEnd(9)} age=${String(ageH).padStart(3)}h rows=${String(r.rowsIngested).padStart(5)} err=${r.error ?? '-'}`)
}
await p.$disconnect(); process.exit(0)
