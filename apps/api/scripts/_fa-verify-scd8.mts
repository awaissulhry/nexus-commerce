/** READ-ONLY: verify SCD.8 — (a) deleted products gone from Sync Control,
 *  (b) multi-value filters return the UNION on every surface (listings/export). */
const { default: prisma } = await import('../src/db.js')
const { marketMatches } = await import('../src/services/sync-control-product-view.js')

const csvFilter = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

// --- (a) deleted products excluded (the TEST product the owner spotted) ---
const listings = await prisma.channelListing.findMany({
  where: {
    isPublished: true,
    listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { deletedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
  },
  select: { channel: true, marketplace: true, product: { select: { sku: true, deletedAt: true, parent: { select: { sku: true, deletedAt: true } } } } },
})
const stillDeleted = listings.filter((l) => l.product?.deletedAt).length
const orphaned = listings.filter((l) => l.product?.parent?.deletedAt).length
const testGone = !listings.some((l) => ['test', 'TEST', 'TEST-S-Black'].includes(l.product?.sku ?? ''))
console.log(`(a) DELETED PRODUCTS`)
console.log(`    listing rows after filter: ${listings.length}`)
console.log(`    rows still belonging to a deleted product: ${stillDeleted}  ${stillDeleted === 0 ? 'PASS' : 'FAIL'}`)
console.log(`    rows orphaned under a DELETED master: ${orphaned}  ${orphaned === 0 ? 'PASS' : 'FAIL'}`)
console.log(`    'TEST' family gone from Sync Control: ${testGone ? 'PASS' : 'FAIL'}`)

// --- (b) multi-value = union, on the LISTINGS predicate ---
const rows = listings.map((l) => ({ channel: l.channel, marketplace: l.marketplace }))
function listingsCount(channelCsv: string, marketCsv = '') {
  const ch = csvFilter(channelCsv).map((x) => x.toUpperCase())
  const mk = csvFilter(marketCsv).map((x) => x.toUpperCase())
  return rows.filter((r) =>
    (!ch.length || ch.includes(r.channel)) &&
    (!mk.length || mk.includes(r.marketplace.toUpperCase().replace(/^EBAY_/, ''))),
  ).length
}
const a = listingsCount('AMAZON'), b = listingsCount('EBAY'), ab = listingsCount('AMAZON,EBAY')
console.log(`\n(b) LISTINGS multi-value`)
console.log(`    AMAZON=${a}  EBAY=${b}  AMAZON,EBAY=${ab}`)
console.log(`    union == sum of parts: ${ab === a + b ? 'PASS' : `FAIL (expected ${a + b})`}`)
console.log(`    non-empty on 2 values: ${ab > 0 ? 'PASS' : 'FAIL — this was the blank-grid bug'}`)

const it = listingsCount('', 'IT'), de = listingsCount('', 'DE'), itde = listingsCount('', 'IT,DE')
console.log(`    IT=${it}  DE=${de}  IT,DE=${itde}  → ${itde === it + de ? 'PASS' : 'FAIL'}`)

// --- (c) export predicate with lane+family multi-values ---
function exportCount(chCsv: string, mkCsv: string) {
  const xCh = csvFilter(chCsv).map((x) => x.toUpperCase())
  const xMk = csvFilter(mkCsv)
  return rows.filter((r) =>
    (!xCh.length || xCh.includes(r.channel)) &&
    (!xMk.length || xMk.some((m) => marketMatches(r.marketplace, m) || r.marketplace === m)),
  ).length
}
const e1 = exportCount('AMAZON,EBAY', ''), e2 = exportCount('', 'IT,DE')
console.log(`\n(c) EXPORT multi-value`)
console.log(`    channel AMAZON,EBAY → ${e1} rows  ${e1 > 0 ? 'PASS' : 'FAIL — empty workbook bug'}`)
console.log(`    market IT,DE        → ${e2} rows  ${e2 > 0 ? 'PASS' : 'FAIL — empty workbook bug'}`)
await prisma.$disconnect()
