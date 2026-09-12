import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { listDrafts } = await import('../src/services/ai/enrichment/draft.service.js')
const ids = (await prisma.product.findMany({ where: { sku: { in: ['AIREON','AIRMESH-JACKET'] } }, select: { id: true } })).map(p => p.id)
const rows = await listDrafts({ productIds: ids, channel: null, marketplace: null, status: ['pending','failed'] })
console.log(`overlay rows: ${rows.length}`)
for (const r of rows) {
  const v = Array.isArray(r.violations) ? (r.violations as Array<{severity:string}>).map(x=>x.severity).join('/') : '-'
  console.log(`  ${r.columnKey.padEnd(14)} ${r.status.padEnd(8)} stale=${String(r.stale).padEnd(5)} unverified=${String(r.unverified).padEnd(5)} violations=${v}`)
}
console.log('pending (would tint a cell):', rows.filter(r=>r.status==='pending').length)
console.log('failed  (must NOT tint):    ', rows.filter(r=>r.status==='failed').length)
await prisma.$disconnect()
