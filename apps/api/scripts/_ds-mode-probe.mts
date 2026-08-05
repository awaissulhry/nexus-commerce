/** READ-ONLY: for each SKU, show what the Studio/preview mode derivation
 *  (children > 0 ? group : single) decides, versus whether the product
 *  actually carries per-colour curation and which push path serves it. */
const { default: prisma } = await import('../src/db.js')

const SKUS = process.argv.slice(2)
for (const sku of SKUS) {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true } })
  if (!p) { console.log(`${sku}: NOT FOUND`); continue }
  const children = await prisma.product.count({ where: { parentId: p.id, deletedAt: null } })
  const curated = await prisma.listingImage.findMany({
    where: { productId: p.id, platform: 'EBAY', mediaType: 'IMAGE' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true },
  })
  const groupRows = curated.filter((r) => !r.variationId && r.variantGroupKey && r.variantGroupValue)
  const buckets = new Set(groupRows.map((r) => `${r.variantGroupKey}::${r.variantGroupValue}`))
  const memberOf = await prisma.sharedListingMembership.count({ where: { parentSku: sku, status: 'ACTIVE' } })
  const isMember = await prisma.sharedListingMembership.count({ where: { productId: p.id, status: 'ACTIVE' } })
  const mode = children > 0 ? 'group' : 'single'
  console.log(
    `${sku.padEnd(26)} children=${String(children).padStart(3)}  → preview mode='${mode}'` +
    `  colourBuckets=${buckets.size}  poolMembersFrontedBySku=${memberOf}  ownMemberships=${isMember}` +
    (mode === 'single' && buckets.size > 0 ? '   ⚠️  HAS per-colour curation but gallery_groups renders EMPTY' : ''),
  )
}
await prisma.$disconnect()
