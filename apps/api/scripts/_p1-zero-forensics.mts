/** READ-ONLY P1 forensics: what did the manual zero-out write, when, and what
 *  is the fight doing to quantities right now? */
const { default: prisma } = await import('../src/db.js')

// 1. Amazon rows by market × mode (pinned@0 vs follow)
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, product: { deletedAt: null } },
  select: { marketplace: true, quantity: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, updatedAt: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const agg = new Map<string, number>()
for (const c of cls) {
  const fba = c.fulfillmentMethod === 'FBA' || c.product?.fulfillmentMethod === 'FBA'
  const mode = fba ? 'FBA' : c.syncPaused ? 'PAUSED' : c.followMasterQuantity === false ? (c.quantityOverride === 0 ? 'PINNED@0' : `PINNED@${c.quantityOverride}`) : 'FOLLOW'
  const k = `${c.marketplace}|${mode}`
  agg.set(k, (agg.get(k) ?? 0) + 1)
}
console.log('AMAZON rows by market × mode:')
for (const [k, n] of [...agg.entries()].sort()) console.log(`  ${k.padEnd(22)} ${n}`)

// 2. when were the pins written? (audit trail)
const audit = await prisma.syncControlAudit.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 3 * 24 * 3600e3) } },
  orderBy: { createdAt: 'desc' }, take: 2000,
  select: { createdAt: true, field: true, actor: true, scopeName: true, after: true },
})
const byBatch = new Map<string, number>()
for (const a of audit) {
  const k = `${a.createdAt.toISOString().slice(0, 16)} ${a.field} ${a.actor}`
  byBatch.set(k, (byBatch.get(k) ?? 0) + 1)
}
console.log('\naudit batches (last 3 days, by minute):')
for (const [k, n] of [...byBatch.entries()].sort().reverse().slice(0, 14)) console.log(`  ${k.padEnd(60)} ${n}`)

// 3. the tug-of-war: recent Amazon QUANTITY_UPDATE pushes by qty + status
const pushes = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } },
  select: { syncStatus: true, targetRegion: true, payload: true, createdAt: true },
})
let zeros = 0, positives = 0
const byHour = new Map<string, { z: number; p: number }>()
for (const p of pushes) {
  const q = (p.payload as any)?.quantity
  const h = p.createdAt.toISOString().slice(0, 13)
  const e = byHour.get(h) ?? { z: 0, p: 0 }
  if (q === 0) { zeros++; e.z++ } else { positives++; e.p++ }
  byHour.set(h, e)
}
console.log(`\nAmazon qty pushes last 24h: ${pushes.length} (zero=${zeros}, positive=${positives})`)
for (const [h, e] of [...byHour.entries()].sort().slice(-10)) console.log(`  ${h}: zeros=${e.z} positives=${e.p}`)

// 4. IT rows whose DB says stocked — how many (these are what the owner expects live)
const itStocked = cls.filter((c) => c.marketplace === 'IT' && c.followMasterQuantity !== false && (c.quantity ?? 0) > 0).length
console.log(`\nIT FOLLOW rows with DB quantity > 0: ${itStocked} (owner expects these LIVE on Amazon)`)
await prisma.$disconnect()
