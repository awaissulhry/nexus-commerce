/** READ-ONLY. Did the re-consent actually land server-side, despite the UI error? */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY' },
  orderBy: { updatedAt: 'desc' }, take: 4,
  select: { id: true, isActive: true, isPrimary: true, externalAccountId: true, displayName: true,
            ebaySignInName: true, tokenExpiresAt: true, updatedAt: true, lastSyncStatus: true },
})
for (const r of rows) console.log(`  ${r.isActive?'ACTIVE  ':'inactive'} primary=${String(r.isPrimary).padEnd(5)} extId=${JSON.stringify(r.externalAccountId)} display=${JSON.stringify(r.displayName)} updated=${r.updatedAt.toISOString()}`)
const active = await prisma.channelConnection.count({ where: { channelType: 'EBAY', isActive: true } })
const total = await prisma.channelConnection.count({ where: { channelType: 'EBAY' } })
console.log(`\nactive eBay: ${active}   total eBay rows: ${total}`)
await prisma.$disconnect()
