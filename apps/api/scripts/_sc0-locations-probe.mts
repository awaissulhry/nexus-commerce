/** READ-ONLY: existing servesMarketplaces values + all locations. */
const { default: prisma } = await import('../src/db.js')
const locs = await prisma.stockLocation.findMany({ select: { code: true, type: true, isActive: true, servesMarketplaces: true, externalChannel: true } })
for (const l of locs) console.log(`${l.code.padEnd(16)} type=${l.type.padEnd(16)} active=${l.isActive} serves=${JSON.stringify(l.servesMarketplaces)} ext=${l.externalChannel ?? '-'}`)
await prisma.$disconnect()
process.exit(0)
