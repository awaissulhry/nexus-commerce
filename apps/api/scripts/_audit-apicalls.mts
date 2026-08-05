const { default: prisma } = await import('../src/db.js')
// find the table recordApiCall writes to
const rows = await prisma.$queryRawUnsafe(`
  SELECT "createdAt", operation, method, endpoint, "statusCode", "triggeredBy"
  FROM "ChannelApiCall"
  WHERE channel='EBAY' AND "createdAt" > '2026-07-26T04:00:00Z'
  ORDER BY "createdAt" ASC LIMIT 60
`).catch(async () => prisma.$queryRawUnsafe(`
  SELECT "createdAt", operation, method, endpoint, "statusCode"
  FROM "ApiCallLog" WHERE channel='EBAY' AND "createdAt" > '2026-07-26T04:00:00Z'
  ORDER BY "createdAt" ASC LIMIT 60
`)) as Array<Record<string, unknown>>
for (const r of rows) console.log(`${new Date(String(r.createdAt)).toISOString()}  ${r.method}  ${r.operation}  ${r.statusCode ?? ''}  ${String(r.triggeredBy ?? '')}`)
console.log('total:', rows.length)
await prisma.$disconnect()
