/** READ-ONLY: does membership synthesis produce rich ALT1 rows? */
const { default: prisma } = await import('../src/db.js')
const { loadSharedMembershipRows } = await import('../src/services/ebay-shared-membership-rows.js')
const { buildFlatRow } = await import('../src/services/ebay-variation-push.service.js')

const shells = await prisma.product.findMany({
  where: { sku: { in: ['AIRMESH-JACKET', 'AIRMESH-JACKET-ALT1'] }, deletedAt: null },
  include: { channelListings: { where: { channel: 'EBAY' } }, images: true },
})
const parentRows = shells.map((p) => buildFlatRow(p as never, {}))
console.log('parent rows:', parentRows.map((r) => `${r.sku} isParent=${(r as Record<string, unknown>)._isParent}`))

const sharedRows = await loadSharedMembershipRows(prisma as never, parentRows as never, parentRows as never)
console.log('synthesized:', sharedRows.length)
for (const row of (sharedRows as Array<Record<string, unknown>>).filter((r) => String(r.parent_sku) === 'AIRMESH-JACKET-ALT1').slice(0, 3)) {
  console.log(JSON.stringify({
    rowId: row._rowId, sku: row.sku,
    title: String(row.title ?? '').slice(0, 40),
    price: row.it_price, itemId: row.it_item_id,
    taglia: row.aspect_taglia ?? row.aspect_Taglia,
    condition: row.condition,
    keys: Object.keys(row).length,
  }))
}
await prisma.$disconnect()
