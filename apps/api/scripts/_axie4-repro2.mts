const { default: prisma } = await import('../src/db.js')
const { validateBulksheetStreaming } = await import('../src/services/advertising/bulksheet/import-validate.js')
const job = await prisma.importJob.create({ data: { jobName: 'repro', source: 'upload', filename: 'repro.xlsx', fileKind: 'xlsx', targetEntity: 'adsBulksheet', status: 'PROCESSING' }, select: { id: true } })
try {
  const r = await validateBulksheetStreaming(process.argv[2]!, async (batch) => {
    await prisma.importJobRow.createMany({ data: batch.map((x) => ({ jobId: job.id, rowIndex: x.rowNumber, status: 'PENDING', parsedValues: {} as object })) })
  }, { batchSize: 5000 })
  console.log('RESULT structural=', r.structuralError, 'counts=', JSON.stringify(r.counts))
} catch (e) {
  console.log('THREW:', (e as Error).message)
  console.log((e as Error).stack?.split('\n').slice(0,10).join('\n'))
}
await prisma.importJob.delete({ where: { id: job.id } }).catch(()=>{})
await prisma.$disconnect()
