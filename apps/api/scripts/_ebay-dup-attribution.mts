/** READ-ONLY. Two ACTIVE eBay rows now exist for one physical account.
 *  Which one owns the data? That decides the safe cleanup direction. */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY', isActive: true },
  select: { id: true, isPrimary: true, externalAccountId: true, displayName: true, createdAt: true },
})
for (const r of rows) {
  const [cl, slm, ord, vcl, camp] = await Promise.all([
    prisma.channelListing.count({ where: { channelConnectionId: r.id } }),
    prisma.sharedListingMembership.count({ where: { channelConnectionId: r.id } }),
    prisma.order.count({ where: { channelConnectionId: r.id } }),
    prisma.variantChannelListing.count({ where: { channelConnectionId: r.id } }),
    prisma.ebayCampaign.count({ where: { channelConnectionId: r.id } }).catch(() => 0),
  ])
  console.log(`\n${r.id}  ${r.isPrimary ? '(PRIMARY)' : ''}`)
  console.log(`  identity : ${JSON.stringify(r.externalAccountId)}  name: ${JSON.stringify(r.displayName)}`)
  console.log(`  created  : ${r.createdAt.toISOString()}`)
  console.log(`  owns     : listings=${cl}  memberships=${slm}  orders=${ord}  variantListings=${vcl}  campaigns=${camp}   TOTAL=${cl+slm+ord+vcl+camp}`)
}
await prisma.$disconnect()
