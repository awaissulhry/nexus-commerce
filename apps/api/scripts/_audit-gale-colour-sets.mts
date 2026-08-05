/** READ-ONLY: does GALE actually have curated per-colour image rows, and what
 * key do they use? Distinguishes "count is wrong" from "nothing was sent". */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true, imageAxisPreference: true } })
if (!p) { console.log('GALE-JACKET not found') } else {
  console.log('imageAxisPreference:', JSON.stringify(p.imageAxisPreference))
  const rows = await prisma.listingImage.findMany({
    where: { productId: p.id, platform: 'EBAY' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true },
  })
  console.log('EBAY ListingImage rows:', rows.length)
  const byKey: Record<string, Set<string>> = {}
  let shared = 0, perSku = 0
  for (const r of rows) {
    if (r.variationId) { perSku++; continue }
    if (!r.variantGroupKey) { shared++; continue }
    const k = r.variantGroupKey
    ;(byKey[k] ??= new Set()).add(String(r.variantGroupValue ?? ''))
  }
  console.log('shared/gallery rows:', shared, ' per-SKU rows:', perSku)
  for (const [k, vals] of Object.entries(byKey)) console.log(`  variantGroupKey="${k}" → values ${JSON.stringify([...vals])}`)
  // what aspect keys do the child rows carry?
  const kids = await prisma.product.findMany({ where: { parentId: p.id, deletedAt: null }, select: { sku: true, categoryAttributes: true, variantAttributes: true }, take: 3 })
  for (const k of kids) {
    const ca = (k.categoryAttributes && typeof k.categoryAttributes === 'object' ? (k.categoryAttributes as Record<string, unknown>).variations : null)
    console.log(`  child ${k.sku}: variantAttributes=${JSON.stringify(k.variantAttributes)} categoryAttributes.variations=${JSON.stringify(ca)}`)
  }
}
await prisma.$disconnect()
