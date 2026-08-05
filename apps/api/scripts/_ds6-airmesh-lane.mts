/** READ-ONLY: why did ItemID 257611257473 (AIRMESH-JACKET) come back
 *  'inventory-managed' from the description push, while its sibling revised?
 *  Mirrors the lane detection in ebay-description-push.service.ts exactly. */
const { default: prisma } = await import('../src/db.js')

const ITEM_ID = '257611257473'
const MARKET = 'IT'
const REGION = 'IT'

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const roots = await prisma.product.findMany({
  where: { sku: { in: ['AIRMESH-JACKET', 'AIRMESH-JACKET-ALT1'] }, deletedAt: null },
  select: { id: true, sku: true, parentId: true },
})
console.log('roots:', roots.map((r) => `${r.sku} (${r.id}) parent=${r.parentId ?? 'none'}`).join('\n       '))

for (const root of roots) {
  console.log(`\n═══ ${root.sku} ═══`)
  const children = await prisma.product.findMany({
    where: { parentId: root.id, deletedAt: null },
    select: { id: true, sku: true },
  })
  const familyIds = [root.id, ...children.map((c) => c.id)]
  console.log(`family: 1 root + ${children.length} children`)

  const parentCl = await prisma.channelListing.findFirst({
    where: { productId: root.id, channel: 'EBAY', region: REGION },
    select: { id: true, externalListingId: true, platformAttributes: true },
  })
  console.log('primary ItemID:', parentCl?.externalListingId ?? '<none>')

  // The Incident-#23 lane marker: __offerIds on ANY family CL
  const familyCls = await prisma.channelListing.findMany({
    where: { productId: { in: familyIds }, channel: 'EBAY' },
    select: { productId: true, region: true, externalListingId: true, platformAttributes: true },
  })
  let inventoryManaged = false
  for (const cl of familyCls) {
    const attrs = asObj(cl.platformAttributes)
    const offerIds = attrs.__offerIds
    const n = offerIds && typeof offerIds === 'object' ? Object.keys(offerIds as object).length : 0
    if (n > 0) {
      inventoryManaged = true
      console.log(`  __offerIds on CL ${cl.region}/${cl.externalListingId ?? '-'} → ${n} offer(s)`)
    }
  }
  console.log('lane =', inventoryManaged ? 'A (inventory-managed)' : 'B (trading — revisable)')

  // Adopted shared listings (Lane B targets)
  const memberships = await prisma.sharedListingMembership.findMany({
    where: { parentSku: root.sku, marketplace: MARKET, status: 'ACTIVE' },
    select: { itemId: true },
    orderBy: { itemId: 'asc' },
  })
  const memberItemIds = [...new Set(memberships.map((m) => m.itemId))]
  console.log('ACTIVE adopted memberships:', memberItemIds.length ? memberItemIds.join(', ') : '<none>')

  const primary = parentCl?.externalListingId
  const all = [...(primary ? [primary] : []), ...memberItemIds.filter((i) => i !== primary)]
  for (const id of all) {
    const isPrimary = id === primary
    const outcome = inventoryManaged && isPrimary ? 'inventory-managed (SKIPPED)' : 'trading revise'
    console.log(`  ${id}${isPrimary ? ' [primary]' : ' [adopted]'} → ${outcome}${id === ITEM_ID ? '   <<< the one you asked about' : ''}`)
  }

  const stamp = asObj(parentCl?.platformAttributes).descriptionPush
  console.log('descriptionPush stamp:', stamp ? JSON.stringify(stamp) : '<never pushed>')
  console.log('assigned theme:', asObj(parentCl?.platformAttributes).descriptionThemeId ?? '<default>')
}

await prisma.$disconnect()
