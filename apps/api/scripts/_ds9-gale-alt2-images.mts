/** READ-ONLY: prove the P5 dedup is what drops each colour's hero for
 *  GALE-JACKET-ALT2 — is each colour's position-1 URL also in the shared
 *  (cover+common) bucket? */
const { default: prisma } = await import('../src/db.js')
const root = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-ALT2', deletedAt: null }, select: { id: true, sku: true, parentId: true },
})
if (!root) { console.log('GALE-JACKET-ALT2 not found'); process.exit(0) }
const familyRoot = root.parentId
  ? (await prisma.product.findFirst({ where: { id: root.parentId }, select: { id: true, sku: true } }))!
  : root
console.log('family root:', familyRoot.sku, familyRoot.id)

const rows = await prisma.listingImage.findMany({
  where: { productId: familyRoot.id, platform: 'EBAY', mediaType: 'IMAGE' },
  select: { url: true, position: true, variantGroupKey: true, variantGroupValue: true, variationId: true, publishStatus: true },
  orderBy: [{ variantGroupValue: 'asc' }, { position: 'asc' }],
})
const shared = rows.filter(r => !r.variantGroupKey && !r.variationId)
const sharedSet = new Set(shared.map(r => r.url))
console.log(`\nSHARED (cover+common): ${shared.length}`)
shared.forEach(r => console.log(`   pos${r.position} ${r.url.slice(-42)}`))

const byColour = new Map<string, typeof rows>()
for (const r of rows) {
  if (!r.variantGroupKey || r.variationId) continue
  const k = String(r.variantGroupValue ?? '')
  if (!byColour.has(k)) byColour.set(k, [])
  byColour.get(k)!.push(r)
}
for (const [colour, list] of byColour) {
  const kept = list.filter(r => !sharedSet.has(r.url))
  const dropped = list.filter(r => sharedSet.has(r.url))
  console.log(`\n${colour}: curated=${list.length}  survivesDedup=${kept.length}  DROPPED=${dropped.length}`)
  list.forEach(r => console.log(`   pos${r.position} ${sharedSet.has(r.url) ? '<<< DROPPED (also in shared)' : 'kept'}  ${r.url.slice(-42)}`))
}
await prisma.$disconnect()
