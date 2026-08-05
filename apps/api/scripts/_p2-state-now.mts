/** READ-ONLY: current Amazon EU mode state + any conflicted SKUs the belt is now freezing. */
const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, product: { deletedAt: null } },
  select: { productId: true, marketplace: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const agg = new Map<string, number>()
const byProduct = new Map<string, { follow: string[]; pinned: string[] }>()
for (const c of cls) {
  const fba = c.fulfillmentMethod === 'FBA' || c.product?.fulfillmentMethod === 'FBA'
  const mode = fba ? 'FBA' : c.syncPaused ? 'PAUSED' : c.followMasterQuantity === false ? 'PINNED' : 'FOLLOW'
  agg.set(`${c.marketplace}|${mode}`, (agg.get(`${c.marketplace}|${mode}`) ?? 0) + 1)
  if (!fba && !c.syncPaused) {
    const e = byProduct.get(c.productId) ?? { follow: [], pinned: [] }
    ;(mode === 'PINNED' ? e.pinned : e.follow).push(c.marketplace)
    byProduct.set(c.productId, e)
  }
}
console.log('AMAZON rows by market × mode:')
for (const [k, n] of [...agg.entries()].sort()) console.log(`  ${k.padEnd(16)} ${n}`)
const conflicted = [...byProduct.entries()].filter(([, e]) => e.follow.length > 0 && e.pinned.length > 0)
console.log(`\nSKUs in MIXED follow/pin state (belt now FREEZES all their Amazon pushes): ${conflicted.length}`)
const skuOf = new Map(cls.map((c) => [c.productId, c.product?.sku]))
for (const [pid, e] of conflicted.slice(0, 10)) console.log(`  ${skuOf.get(pid)}: follow=${e.follow.join(',')} pinned=${e.pinned.join(',')}`)

// audit: what happened after the 20:5x restore?
const audit = await prisma.syncControlAudit.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 5 * 3600e3) }, field: { in: ['zeroPin', 'followMasterQuantity'] } },
  orderBy: { createdAt: 'desc' }, take: 1200,
  select: { createdAt: true, field: true },
})
const batches = new Map<string, number>()
for (const a of audit) { const k = `${a.createdAt.toISOString().slice(0, 16)} ${a.field}`; batches.set(k, (batches.get(k) ?? 0) + 1) }
console.log('\naudit last 5h (by minute):')
for (const [k, n] of [...batches.entries()].sort().reverse().slice(0, 12)) console.log(`  ${k.padEnd(44)} ${n}`)
await prisma.$disconnect()
