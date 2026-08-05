/** READ-ONLY: why does the Description Studio "Colori disponibili" section drop
 *  images? Dumps the curated ListingImage rows (shared vs per-group vs per-SKU
 *  pin) for the given SKUs and replays the render-side dedup that groupsGallery
 *  applies (`urls.filter(u => !shared.includes(u))`). */
const { default: prisma } = await import('../src/db.js')

const SKUS = process.argv.slice(2)
if (SKUS.length === 0) SKUS.push('REGAL-JACKET', 'REGAL-JACKET-ALT1')

const short = (u: string) => u.replace(/^https?:\/\/[^/]+\//, '').slice(-42)

for (const sku of SKUS) {
  const p = await prisma.product.findFirst({
    where: { sku },
    select: { id: true, sku: true, name: true, parentId: true },
  })
  console.log(`\n══════ ${sku} ══════`)
  if (!p) { console.log('  NOT FOUND'); continue }
  const childCount = await prisma.product.count({ where: { parentId: p.id, deletedAt: null } })
  console.log(`  productId=${p.id} children=${childCount}`)

  const listings = await prisma.channelListing.findMany({
    where: { productId: p.id, channel: 'EBAY' },
    select: { region: true, externalListingId: true, platformAttributes: true, listingStatus: true },
  })
  for (const l of listings) {
    const a = (l.platformAttributes ?? {}) as Record<string, unknown>
    console.log(`  listing ${l.region} status=${l.listingStatus} itemId=${l.externalListingId ?? '—'} ` +
      `themeId=${String(a.descriptionThemeId ?? '—')} ` +
      `path=${a.adoptedTrading || a.tradingAdopted ? 'TRADING(adopted)' : 'inventory?'} ` +
      `attrKeys=${Object.keys(a).slice(0, 14).join(',')}`)
  }

  const curated = await prisma.listingImage.findMany({
    where: { productId: p.id, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true, position: true, marketplace: true },
  })
  console.log(`  curated ListingImage rows: ${curated.length}`)
  const shared: string[] = []
  const groups = new Map<string, string[]>()
  const pins = new Map<string, string[]>()
  for (const r of curated) {
    if (r.variationId) { (pins.get(r.variationId) ?? pins.set(r.variationId, []).get(r.variationId)!).push(r.url) }
    else if (r.variantGroupKey && r.variantGroupValue) {
      const k = `${r.variantGroupKey}::${r.variantGroupValue}`
      ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(r.url)
    } else shared.push(r.url)
  }
  console.log(`  SHARED (no group key): ${shared.length}`)
  shared.forEach((u, i) => console.log(`     shared[${i}] ${short(u)}`))
  console.log(`  GROUPS: ${groups.size}   PINS(variationId): ${pins.size}`)
  for (const [k, urls] of groups) {
    const kept = urls.filter((u) => !shared.includes(u))
    const dropped = urls.filter((u) => shared.includes(u))
    console.log(`    ▸ ${k}: ${urls.length} curated → ${kept.length} rendered` +
      (dropped.length > 0 ? `  ❌ DROPPED ${dropped.length} (also shared): ${dropped.map((u, i) => `#${urls.indexOf(u) + 1}:${short(u)}`).join(' ')}` : ''))
  }
  if (groups.size === 0) {
    const master = await prisma.productImage.count({ where: { productId: p.id } })
    console.log(`    (no per-colour buckets → gallery_groups renders EMPTY; master ProductImage rows=${master})`)
  }
}
await prisma.$disconnect()
