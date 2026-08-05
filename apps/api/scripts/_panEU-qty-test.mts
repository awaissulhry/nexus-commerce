/** READ-ONLY: is Amazon quantity independent PER MARKETPLACE, or one shared
 *  number per SKU across the EU? Empirical: compare the last-read-back LIVE
 *  quantities of the SAME sku on IT vs DE/FR/ES. If they differ anywhere,
 *  the marketplaces hold independent quantities and zeroing DE is safe. */
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] },
    product: { deletedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
  },
  select: {
    marketplace: true, quantity: true, fulfillmentMethod: true, followMasterQuantity: true,
    updatedAt: true, product: { select: { sku: true } },
  },
})
const bySku = new Map<string, Array<{ m: string; q: number | null; f: string | null }>>()
for (const r of rows) {
  const sku = r.product?.sku ?? ''
  if (!sku) continue
  if (!bySku.has(sku)) bySku.set(sku, [])
  bySku.get(sku)!.push({ m: r.marketplace.toUpperCase(), q: r.quantity, f: r.fulfillmentMethod })
}
let multi = 0, differ = 0, same = 0
const examples: string[] = []
for (const [sku, list] of bySku) {
  const fbm = list.filter((x) => x.f !== 'FBA' && x.f !== 'AFN')
  if (fbm.length < 2) continue
  multi++
  const qs = new Set(fbm.map((x) => String(x.q)))
  if (qs.size > 1) {
    differ++
    if (examples.length < 10) examples.push(`  ${sku.padEnd(38)} ${fbm.map((x) => `${x.m}=${x.q}`).join('  ')}`)
  } else same++
}
console.log(`SKUs listed FBM on >1 Amazon marketplace: ${multi}`)
console.log(`  quantities DIFFER across markets: ${differ}   → independent per-marketplace quantity`)
console.log(`  quantities identical:             ${same}`)
console.log(`\nExamples where they differ:`)
for (const e of examples) console.log(e)
if (!differ) console.log('  (none — cannot rule out a shared quantity from data alone)')

// how many non-IT rows currently sit at 0 already?
const nonIt = rows.filter((r) => !['IT'].includes(r.marketplace.toUpperCase()) && r.fulfillmentMethod !== 'FBA' && r.fulfillmentMethod !== 'AFN')
const atZero = nonIt.filter((r) => (r.quantity ?? 0) === 0).length
const following = nonIt.filter((r) => r.followMasterQuantity).length
console.log(`\nNON-IT writable Amazon rows: ${nonIt.length}`)
console.log(`  already live at qty 0: ${atZero}`)
console.log(`  currently set to FOLLOW the pool: ${following}   ← these are the ones that would keep refilling`)
const nonZero = nonIt.filter((r) => (r.quantity ?? 0) > 0)
console.log(`  currently carrying stock: ${nonZero.length}  (total ${nonZero.reduce((a, r) => a + (r.quantity ?? 0), 0)} units advertised outside IT)`)
await prisma.$disconnect()
