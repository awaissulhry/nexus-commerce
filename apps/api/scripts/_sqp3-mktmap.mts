import prisma from '../src/db.js'
const rows = await prisma.marketplace.findMany({ where: { channel: 'AMAZON', marketplaceId: { not: null } }, select: { code: true, marketplaceId: true } })
for (const r of rows) console.log(`MAP ${r.marketplaceId} = ${r.code}`)
await prisma.$disconnect()
