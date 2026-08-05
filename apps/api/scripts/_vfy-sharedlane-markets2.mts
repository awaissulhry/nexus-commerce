import { default as prisma } from '../src/db.js'

// DE listings' products, and whether the SAME product also has an IT CL flagged shared
const de = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'DE' },
  select: { productId: true, flatFileSnapshot: true, price: true, externalListingId: true, listingStatus: true },
})
console.log('--- DE listings ---')
for (const d of de) {
  const s = (d.flatFileSnapshot ?? {}) as Record<string, unknown>
  console.log(d.productId, 'status=', d.listingStatus, 'ext=', d.externalListingId, 'price=', String(d.price),
    'shared=', s.shared_sku_listing, 'theme=', s.variation_theme, 'sku=', s.sku, 'parent_sku=', s.parent_sku)
}
const pids = [...new Set(de.map((d) => d.productId))]
const itForSame = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'IT', productId: { in: pids } },
  select: { productId: true, flatFileSnapshot: true },
})
console.log('--- IT CL for the same products ---')
for (const c of itForSame) {
  const s = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  console.log(c.productId, 'shared=', s.shared_sku_listing, 'theme=', s.variation_theme)
}

// Do any IT shared-flagged families carry a DE price anywhere (would clear the price guard)?
const itShared = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'IT' },
  select: { productId: true, flatFileSnapshot: true },
})
let withDePrice = 0
const deKeys = new Set<string>()
for (const c of itShared) {
  const s = (c.flatFileSnapshot ?? {}) as Record<string, unknown> | null
  if (!s || s.shared_sku_listing !== true) continue
  for (const k of Object.keys(s)) if (k.startsWith('de_')) deKeys.add(k)
  const p = s.de_price
  if (p != null && String(p).trim() !== '') withDePrice++
}
console.log('IT shared-flagged snapshots carrying de_price:', withDePrice, 'de_* keys seen:', JSON.stringify([...deKeys]))

await prisma.$disconnect()
