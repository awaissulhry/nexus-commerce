const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY' }, orderBy: { createdAt: 'asc' },
  select: { id: true, isActive: true, isPrimary: true, externalAccountId: true, displayName: true,
            createdAt: true, updatedAt: true, accessToken: true },
})
for (const r of rows) console.log(
  `${r.createdAt.toISOString()}  upd=${r.updatedAt.toISOString()}  ${r.isActive?'ACTIVE  ':'inactive'}  primary=${String(r.isPrimary).padEnd(5)}  tok=${r.accessToken?'yes':'no '}  extId=${JSON.stringify(r.externalAccountId)}  ${JSON.stringify(r.displayName)}`)
await prisma.$disconnect()
