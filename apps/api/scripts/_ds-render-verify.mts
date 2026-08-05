/** READ-ONLY verification: render each SKU's description exactly as a push
 *  would (same resolver, same theme) and compare the per-colour sections
 *  against what is actually curated. No writes, no eBay calls. */
const { default: prisma } = await import('../src/db.js')
const { renderListingDescriptionSafe, resolveDescriptionMode } = await import('../src/services/ebay-description-theme.service.js')

const SKUS = process.argv.slice(2)
for (const sku of SKUS) {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true } })
  if (!p) { console.log(`\n${sku}: NOT FOUND`); continue }

  // What IS curated, per colour.
  const curated = await prisma.listingImage.findMany({
    where: { productId: p.id, platform: 'EBAY', mediaType: 'IMAGE', variationId: null },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, url: true },
  })
  const curatedByColour = new Map<string, string[]>()
  for (const r of curated) {
    if (!r.variantGroupKey || !r.variantGroupValue) continue
    if (!curatedByColour.has(r.variantGroupValue)) curatedByColour.set(r.variantGroupValue, [])
    curatedByColour.get(r.variantGroupValue)!.push(r.url)
  }

  const listing = await prisma.channelListing.findFirst({
    where: { productId: p.id, channel: 'EBAY', region: 'IT' },
    select: { description: true, title: true },
  })
  const mode = await resolveDescriptionMode(prisma, p.id)
  const res = await renderListingDescriptionSafe(prisma, {
    productId: p.id,
    marketplace: 'IT',
    mode,
    body: listing?.description ?? '<p>corpo</p>',
    title: listing?.title ?? undefined,
  })

  // Parse the rendered "Colori disponibili" sections.
  const rendered = new Map<string, number>()
  for (const m of res.html.matchAll(/<div class="ggroup"><h3 class="gg-title">([^<]*)<\/h3><div class="gg-grid">(.*?)<\/div>/gs)) {
    rendered.set(m[1], (m[2].match(/<img /g) ?? []).length)
  }

  console.log(`\n══════ ${sku} ══════  mode='${mode}'  themed=${res.themed}`)
  if (res.warnings.length > 0) console.log(`  warnings: ${res.warnings.join(' | ')}`)
  let ok = true
  for (const [colour, urls] of curatedByColour) {
    const got = rendered.get(colour) ?? 0
    const flag = got === urls.length ? '✅' : '❌'
    if (got !== urls.length) ok = false
    console.log(`  ${flag} ${colour.padEnd(18)} curated ${urls.length} → rendered ${got}`)
  }
  if (curatedByColour.size === 0) console.log('  (no per-colour buckets)')
  console.log(`  RESULT: ${ok && rendered.size === curatedByColour.size ? 'every curated colour photo is rendered' : 'MISMATCH'}` +
    `  (sections rendered: ${rendered.size}/${curatedByColour.size})`)
}
await prisma.$disconnect()
