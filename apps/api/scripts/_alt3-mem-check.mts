/** READ-ONLY: ALT3 membership state mid-heal. */
const { default: prisma } = await import('../src/db.js')
const mems = await prisma.sharedListingMembership.findMany({
  where: { itemId: '256566112769' },
  select: { sku: true, parentSku: true, productId: true, price: true, variationSpecifics: true },
  orderBy: { sku: 'asc' },
})
console.log(`ALT3 memberships: ${mems.length}`)
for (const m of mems) console.log(`  ${m.sku} parent=${m.parentSku} pid=${m.productId ? 'Y' : 'null'} price=${m.price} specs=${JSON.stringify(m.variationSpecifics).slice(0, 60)}`)
await prisma.$disconnect()
