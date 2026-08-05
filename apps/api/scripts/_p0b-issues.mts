const { default: prisma } = await import('../src/db.js')
const issues = await prisma.listingIssue.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } },
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: { code: true, severity: true, message: true, createdAt: true, channelListing: { select: { product: { select: { sku: true } }, marketplace: true } } },
}).catch((e) => { console.log('listingIssue query failed:', e.message?.slice(0,80)); return [] })
console.log(`ListingIssue rows last 24h: ${issues.length}`)
for (const i of issues) console.log(`  ${i.createdAt.toISOString().slice(5,16)} ${i.channelListing?.product?.sku}@${i.channelListing?.marketplace} [${i.severity}] ${i.code}: ${String(i.message).slice(0, 120)}`)
await prisma.$disconnect()
process.exit(0)
