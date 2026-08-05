const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
const jobs = await prisma.channelImagePublishJob.findMany({
  where: { productId: p!.id, channel: 'EBAY' }, orderBy: { submittedAt: 'desc' }, take: 3,
  select: { submittedAt: true, requestPayload: true },
})
for (const j of jobs) console.log(`${j.submittedAt.toISOString()}  ${JSON.stringify(j.requestPayload)}`)
await prisma.$disconnect()
