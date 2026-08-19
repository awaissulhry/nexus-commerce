/** READ-ONLY. The two daily reconciles now select work by channelConnectionId
 *  instead of by channel alone. This proves the new selection returns the SAME
 *  set as the old one — the parity that matters, without calling eBay. */
const { default: prisma } = await import('../src/db.js')
const R = await import('../src/services/connection-resolver.service.js')

// ── ebay-item-status-reconcile ──
const oldGroups = await prisma.sharedListingMembership.groupBy({
  by: ['itemId', 'marketplace'], where: { status: 'ACTIVE' },
})
const conns = await R.listActiveConnections('EBAY')
let newTotal = 0
for (const c of conns) {
  const g = await prisma.sharedListingMembership.groupBy({
    by: ['itemId', 'marketplace'], where: { status: 'ACTIVE', channelConnectionId: c.id },
  })
  newTotal += g.length
  console.log(`  item-status-reconcile: account ${c.id} -> ${g.length} item groups`)
}
console.log(`  OLD (channel-wide): ${oldGroups.length}   NEW (sum per account): ${newTotal}   ${oldGroups.length === newTotal ? 'PARITY ✓' : 'MISMATCH ✗'}`)

// ── ebay-status-reconcile (still declared-primary; prove the scoped query would match too) ──
const oldListings = await prisma.channelListing.count({
  where: { channel: 'EBAY', listingStatus: { notIn: ['REMOVED', 'CANCELLED'] }, product: { deletedAt: null } },
})
let newListings = 0
for (const c of conns) {
  newListings += await prisma.channelListing.count({
    where: { channel: 'EBAY', listingStatus: { notIn: ['REMOVED', 'CANCELLED'] }, product: { deletedAt: null }, channelConnectionId: c.id },
  })
}
console.log(`\n  status-reconcile listings: OLD ${oldListings}  NEW ${newListings}  ${oldListings === newListings ? 'PARITY ✓' : 'MISMATCH ✗'}`)

// ── ebay-token-refresh: does the JS filter select the same rows as the old query? ──
const oldRefresh = await prisma.channelConnection.findMany({
  where: { isActive: true, channelType: 'EBAY', managedBy: 'oauth',
    OR: [{ refreshToken: { not: null } }, { ebayRefreshToken: { not: null } }] },
  select: { id: true },
})
const newRefresh = (await R.listActiveConnections('EBAY'))
  .filter((c) => c.managedBy === 'oauth' && (c.refreshToken !== null || c.ebayRefreshToken !== null))
console.log(`\n  token-refresh: OLD ${oldRefresh.length} rows  NEW ${newRefresh.length} rows  ${oldRefresh.length === newRefresh.length ? 'PARITY ✓' : 'MISMATCH ✗'}`)
console.log(`    same ids: ${JSON.stringify(oldRefresh.map(r=>r.id).sort()) === JSON.stringify(newRefresh.map(r=>r.id).sort())}`)
await prisma.$disconnect()
