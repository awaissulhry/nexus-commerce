/** READ-ONLY dry-run: feed GALE-JACKET-ALT2's REAL curated rows through the
 *  REAL buildSharedPicturePayload and show exactly what a publish would send.
 *  No eBay calls, no writes. */
const { default: prisma } = await import('../src/db.js')
const { buildSharedPicturePayload } = await import('../src/services/images/ebay-shared-image-publish.service.js')

const root = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-ALT2', deletedAt: null }, select: { id: true } })
const curated = await prisma.listingImage.findMany({
  where: { productId: root!.id, platform: 'EBAY', mediaType: 'IMAGE' },
  orderBy: { position: 'asc' },
  select: { url: true, variantGroupKey: true, variantGroupValue: true, variationId: true },
})
// Live variation axis as eBay declares it on this listing (from the live listing UI).
const out = buildSharedPicturePayload({
  curated: curated as never,
  liveSpecificsSet: { Colore: ['Nero', 'Giallo'] },
  requestedAxis: 'Color',
})
console.log(`curated rows: ${curated.length}`)
console.log(`\ngallery (cover+common): ${out.galleryUrls.length}`)
out.galleryUrls.forEach((u, i) => console.log(`   [${i}] ${u.slice(-40)}`))
console.log(`\naxisName: ${out.axisName}   sharedGallery: ${out.sharedGallery}`)
for (const [val, urls] of Object.entries(out.byValue)) {
  console.log(`\n${val}: ${urls.length} photos WOULD BE SENT`)
  urls.forEach((u, i) => console.log(`   [${i}]${i === 0 ? ' <- Principale' : ''} ${u.slice(-40)}`))
}
console.log(`\nwarnings: ${out.warnings.length ? out.warnings.join(' | ') : 'none'}`)
await prisma.$disconnect()
