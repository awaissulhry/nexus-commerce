const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelListing.groupBy({ by: ['channel','marketplace'], _count: { _all: true } })
console.log(JSON.stringify(rows.map(r=>({c:r.channel,m:r.marketplace,n:r._count._all})),null,0))
await prisma.$disconnect()
