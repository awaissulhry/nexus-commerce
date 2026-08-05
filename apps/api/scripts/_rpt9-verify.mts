const { deriveRowCount } = await import('../src/services/advertising/../sp-api-reports.service.js')
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

console.log('1. deriveRowCount — null when unknown, never a guessed 0')
const cases: Array<[string, unknown, number | null]> = [
  ['flat-file TSV, 3 data rows', 'h1\th2\na\t1\nb\t2\nc\t3', 3],
  ['flat-file, header only', 'h1\th2', 0],
  ['empty string', '   ', 0],
  ['bare array', [{ a: 1 }, { a: 2 }], 2],
  ['JSON with rows array', { salesAndTrafficByDate: [1, 2, 3, 4], meta: { x: 1 } }, 4],
  ['JSON, no arrays', { reportSpecification: { x: 1 } }, null],
  ['null payload', null, null],
]
let ok = 0
for (const [label, input, want] of cases) {
  const got = deriveRowCount(input)
  const pass = got === want
  if (pass) ok++
  console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${label.padEnd(30)} → ${got === null ? 'null' : got} (want ${want === null ? 'null' : want})`)
}
console.log(`   ${ok}/${cases.length} passed`)

console.log('\n2. Export jobs that previously died on a stale link')
const stale = await p.amazonAdsExportJob.findMany({
  where: { status: 'COMPLETED', rowsIngested: 0, errorMessage: { contains: 's3_download_400' } },
  orderBy: { completedAt: 'desc' }, take: 3,
  select: { id: true, resource: true, urlExpiresAt: true, errorMessage: true, completedAt: true },
})
console.log(`   ${stale.length} sampled from the failure backlog`)
for (const j of stale) {
  const expired = j.urlExpiresAt ? j.urlExpiresAt.getTime() < Date.now() : true
  console.log(`   ${j.id} ${j.resource} urlExpired=${expired}`)
}
if (stale.length) {
  const { ingestCompletedExport } = await import('../src/services/advertising/ads-v1-sync.service.js')
  console.log('\n   re-running ingest on them WITH the inline re-mint:')
  for (const j of stale) {
    const r = await ingestCompletedExport(j.id).catch(e => ({ error: (e as Error).message }))
    console.log('   →', JSON.stringify(r))
  }
}
await p.$disconnect(); process.exit(0)
