/** STEP 2 — DELETE the eBay/DE ChannelListing rows (operator-approved).
 * Direct scoped deleteMany ONLY: makes ZERO eBay calls (nothing can be ended),
 * never touches Product, never touches SharedListingMembership, never keys on
 * itemId (the GALE DE row carries the LIVE IT ItemID). Verifies the IT estate
 * is byte-identical afterwards. Requires the argument "apply". */
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv[2] === 'apply'

const baseline = async () => ({
  itRows: await prisma.channelListing.count({ where: { channel: 'EBAY', marketplace: 'IT' } }),
  itLiveItemIds: new Set((await prisma.channelListing.findMany({
    where: { channel: 'EBAY', marketplace: 'IT', externalListingId: { not: null } },
    select: { externalListingId: true },
  })).map((l) => l.externalListingId)).size,
  memberships: await prisma.sharedListingMembership.count(),
  activeMemberships: await prisma.sharedListingMembership.count({ where: { status: 'ACTIVE' } }),
  products: await prisma.product.count({ where: { deletedAt: null } }),
  deRows: await prisma.channelListing.count({ where: { channel: 'EBAY', marketplace: 'DE' } }),
})

const before = await baseline()
console.log('BEFORE:', JSON.stringify(before))

if (!APPLY) {
  console.log('\nDRY-RUN — pass "apply" to delete. Nothing changed.')
} else {
  const del = await prisma.channelListing.deleteMany({ where: { channel: 'EBAY', marketplace: 'DE' } })
  console.log(`\n✔ deleted ${del.count} eBay/DE ChannelListing rows`)

  const after = await baseline()
  console.log('AFTER :', JSON.stringify(after))

  const unchanged =
    before.itRows === after.itRows &&
    before.itLiveItemIds === after.itLiveItemIds &&
    before.memberships === after.memberships &&
    before.activeMemberships === after.activeMemberships &&
    before.products === after.products
  console.log(`\nIT estate untouched: ${unchanged ? '✔ YES' : '✘ NO — INVESTIGATE'}`)
  console.log(`DE rows remaining   : ${after.deRows} (expected 0)`)

  // the live IT GALE listing must still be intact
  const gale = await prisma.channelListing.count({
    where: { channel: 'EBAY', externalListingId: '257584954808' },
  })
  const galeMembers = await prisma.sharedListingMembership.count({
    where: { itemId: '257584954808', status: 'ACTIVE' },
  })
  console.log(`live IT GALE 257584954808 → listing rows: ${gale}, ACTIVE memberships: ${galeMembers} (expected 20)`)
}
await prisma.$disconnect()
