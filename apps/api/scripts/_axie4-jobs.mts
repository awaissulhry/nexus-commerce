const { default: p } = await import('../src/db.js')
const rows = await p.importJob.findMany({
  where: { targetEntity: 'adsBulksheet' }, orderBy: { createdAt: 'desc' }, take: 5,
  select: { id: true, filename: true, status: true, totalRows: true, failedRows: true, skippedRows: true, errorSummary: true },
})
for (const r of rows) console.log(`${(r.filename ?? '').padEnd(24)} ${r.status.padEnd(16)} total=${String(r.totalRows).padStart(6)} err=${String(r.failedRows).padStart(5)} | ${(r.errorSummary ?? '').slice(0,90)}`)
await p.$disconnect()
