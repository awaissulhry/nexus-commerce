/** READ-ONLY: knee-slider pool membership specifics shapes. */
const { default: prisma } = await import('../src/db.js')
const mems = await prisma.sharedListingMembership.findMany({
  where: { parentSku: { contains: 'knee-slider' } },
  select: { itemId: true, parentSku: true, sku: true, variationSpecifics: true, productId: true },
  take: 60,
})
const byItem = new Map<string, Array<string>>()
for (const m of mems) {
  const arr = byItem.get(m.itemId) ?? []
  arr.push(`${m.sku} :: ${JSON.stringify(m.variationSpecifics)} :: pid=${m.productId ? 'Y' : 'null'}`)
  byItem.set(m.itemId, arr)
}
for (const [item, arr] of byItem) {
  console.log(`ITEM ${item} (${arr.length} memberships):`)
  for (const a of arr.slice(0, 3)) console.log(`  ${a}`)
}
await prisma.$disconnect()
