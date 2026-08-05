/** READ-ONLY: what do FR and ES actually DO? Orders per Amazon marketplace
 *  (last 90 days) + how many DB rows each market carries. */
const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 90 * 24 * 3600e3)
const orders = await prisma.order.groupBy({
  by: ['marketplace'],
  where: { channel: 'AMAZON', purchaseDate: { gte: since } },
  _count: true,
})
console.log('AMAZON orders last 90 days by marketplace:')
for (const o of orders.sort((a, b) => (b._count as number) - (a._count as number))) {
  console.log(`  ${String(o.marketplace).padEnd(8)} ${o._count}`)
}
// revenue-ish: order items count
const rows = await prisma.channelListing.groupBy({
  by: ['marketplace'],
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, product: { deletedAt: null } },
  _count: true,
})
console.log('\npublished AMAZON rows in DB by marketplace:')
for (const r of rows.sort()) console.log(`  ${String(r.marketplace).padEnd(8)} ${r._count}`)
await prisma.$disconnect()
