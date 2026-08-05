/**
 * Proves the apply-claim is atomic: N concurrent compare-and-swaps on the same
 * ImportJob row, exactly one must win. Creates and deletes its own job.
 */
const { default: prisma } = await import('../src/db.js')
const jobId = `p4-claim-${process.pid}`
const CLAIMABLE = ['PENDING_PREVIEW', 'FAILED_PARTIAL', 'COMPLETED']

await prisma.importJob.create({
  data: { id: jobId, jobName: 'p4-claim', fileKind: 'xlsx', targetEntity: 'adsBulksheet', status: 'PENDING_PREVIEW', totalRows: 0 },
})

try {
  for (const n of [2, 5, 10]) {
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'PENDING_PREVIEW' } })
    const results = await Promise.all(Array.from({ length: n }, () =>
      prisma.importJob.updateMany({ where: { id: jobId, status: { in: CLAIMABLE } }, data: { status: 'APPLYING' } })))
    const winners = results.filter((r) => r.count === 1).length
    console.log(`${n} concurrent claims -> ${winners} winner(s), ${results.length - winners} refused  ${winners === 1 ? 'PASS' : 'FAIL'}`)
  }

  // A job already APPLYING can never be claimed.
  const blocked = await prisma.importJob.updateMany({ where: { id: jobId, status: { in: CLAIMABLE } }, data: { status: 'APPLYING' } })
  console.log(`claim while APPLYING -> count=${blocked.count} ${blocked.count === 0 ? 'PASS' : 'FAIL'}`)

  // A finished job is still re-appliable (documented recovery path).
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'FAILED_PARTIAL' } })
  const retry = await prisma.importJob.updateMany({ where: { id: jobId, status: { in: CLAIMABLE } }, data: { status: 'APPLYING' } })
  console.log(`retry after FAILED_PARTIAL -> count=${retry.count} ${retry.count === 1 ? 'PASS' : 'FAIL'}`)
} finally {
  await prisma.importJob.delete({ where: { id: jobId } })
  console.log('job removed')
}
