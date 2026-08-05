/** READ-ONLY: prove what the ads ProductSelection picker actually shows.
 *  Counts the exact rows GET /api/products/search returns for the picker's
 *  call (parentId=null, no channel filter) and splits them by channel. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const base = { deletedAt: null, parentId: null } as any

const total = await p.productReadCache.count({ where: base })
L(`══ PICKER POOL — what /api/products/search?limit=100 draws from ══`)
L(`  top-level rows (parentId=null, not deleted): ${total}`)
L(`  the picker requests limit=100 → it can only ever see the first 100`)

L('\n══ SPLIT BY CHANNEL PRESENCE ═════════════════════════════════════')
const rows = await p.productReadCache.findMany({
  where: base,
  select: { id: true, sku: true, name: true, channelKeys: true, status: true, childCount: true },
  orderBy: { updatedAt: 'desc' },
})
const hasAmz = (k: string[]) => k.some((x) => x.startsWith('AMAZON'))
const hasEbay = (k: string[]) => k.some((x) => x.startsWith('EBAY'))
const hasShop = (k: string[]) => k.some((x) => x.startsWith('SHOPIFY'))

const amazon = rows.filter((r: any) => hasAmz(r.channelKeys))
const ebayOnly = rows.filter((r: any) => hasEbay(r.channelKeys) && !hasAmz(r.channelKeys))
const shopOnly = rows.filter((r: any) => hasShop(r.channelKeys) && !hasAmz(r.channelKeys) && !hasEbay(r.channelKeys))
const none = rows.filter((r: any) => r.channelKeys.length === 0)

L(`  on Amazon (any marketplace):   ${amazon.length}`)
L(`  eBay-only (NOT on Amazon):     ${ebayOnly.length}   <-- leaking into the Amazon picker`)
L(`  Shopify-only:                  ${shopOnly.length}   <-- leaking`)
L(`  no channel listing at all:     ${none.length}   <-- leaking`)
L(`  ------------------------------------------------`)
L(`  NOT advertisable on Amazon:    ${ebayOnly.length + shopOnly.length + none.length} of ${total}`)

L('\n══ FIRST 100 (what the picker literally renders today) ═══════════')
const first100 = rows.slice(0, 100)
const bad100 = first100.filter((r: any) => !hasAmz(r.channelKeys))
L(`  of the first 100 rows, ${bad100.length} are NOT on Amazon`)
L('  sample of the leaked rows:')
for (const r of bad100.slice(0, 12)) {
  L(`    ${String(r.sku).padEnd(28)} ${String(r.status).padEnd(8)} keys=[${r.channelKeys.join(',') || '—'}]  ${String(r.name).slice(0, 44)}`)
}

L('\n══ AMAZON channelKeys IN USE (the values a filter would pass) ════')
const keyCount: Record<string, number> = {}
for (const r of rows) for (const k of r.channelKeys) keyCount[k] = (keyCount[k] ?? 0) + 1
for (const [k, n] of Object.entries(keyCount).sort((a, b) => b[1] - a[1])) L(`  ${k.padEnd(20)} ${n}`)

L('\n══ ASIN AVAILABILITY (picker shows p.asin, API never returns it) ══')
const listings = await p.channelListing.count({ where: { channel: 'AMAZON' } })
L(`  AMAZON ChannelListing rows: ${listings}`)
const sample = await p.channelListing.findMany({
  where: { channel: 'AMAZON' },
  select: { externalListingId: true, platformProductId: true, marketplace: true, listingStatus: true, isPublished: true, fulfillmentMethod: true },
  take: 5,
})
for (const s of sample) L(`    ext=${s.externalListingId} ppid=${s.platformProductId} mkt=${s.marketplace} status=${s.listingStatus} published=${s.isPublished} fm=${s.fulfillmentMethod}`)

L('\n══ ProductReadCache carries NO asin column ═══════════════════════')
L('  → SpwProduct.asin is always "" in every builder that uses the picker')

await prisma.$disconnect()
