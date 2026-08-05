const { default: prisma } = await import('../src/db.js')
const rows = await prisma.outboundApiCallLog.findMany({
  where: { channel: 'EBAY', createdAt: { gte: new Date('2026-07-26T04:00:00Z') } },
  orderBy: { createdAt: 'asc' }, take: 80,
  select: { createdAt: true, operation: true, method: true, statusCode: true, triggeredBy: true, productId: true },
})
console.log('EBAY api calls since 04:00Z:', rows.length)
const summary: Record<string, number> = {}
for (const r of rows) summary[`${r.method} ${r.operation} → ${r.statusCode} (${r.triggeredBy})`] = (summary[`${r.method} ${r.operation} → ${r.statusCode} (${r.triggeredBy})`] ?? 0) + 1
console.log(JSON.stringify(summary, null, 1))
// writes only, with timestamps
for (const r of rows.filter((x) => x.method !== 'GET')) {
  console.log(`  ${r.createdAt.toISOString()}  ${r.method} ${r.operation} → ${r.statusCode}  trig=${r.triggeredBy}`)
}
await prisma.$disconnect()
