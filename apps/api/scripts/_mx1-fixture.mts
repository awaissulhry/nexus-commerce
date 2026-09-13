/** MX.1 — create (or find) the disposable fixture family on ONE named database. `--delete` removes it by VALUE (sku prefix). */
const url = process.argv[2]; const mode = process.argv[3] ?? 'create'
if (!url) { console.error('usage: tsx _mx1-fixture.mts <DATABASE_URL> [create|delete]'); process.exit(2) }
if (!/127\.0\.0\.1|localhost/.test(url)) { console.error('REFUSED: not a local database'); process.exit(3) }
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const WS = 'nexus_legacy_workspace'; const SKU = 'MX-TEST-20260913'
console.log('db:', (await p.$queryRawUnsafe<any[]>(`SELECT current_database() d`))[0].d)
if (mode === 'delete') {
  const prods = await p.product.findMany({ where: { sku: { startsWith: SKU } }, select: { id: true, sku: true } })
  const ids = prods.map(x => x.id)
  const q = await p.outboundSyncQueue.deleteMany({ where: { productId: { in: ids } } })
  const a = await p.syncControlAudit.deleteMany({ where: { scopeName: { contains: SKU } } })
  const ops = await p.bulkOperation.findMany({ where: { changes: { path: ['kind'], equals: 'studio-matrix-verb' } }, select: { id: true, changes: true } })
  const mine = ops.filter(o => ids.includes((o.changes as any)?.productId)).map(o => o.id)
  const b = mine.length ? await p.bulkOperation.deleteMany({ where: { id: { in: mine } } }) : { count: 0 }
  const pce = await p.priceChangeEvent.deleteMany({ where: { productId: { in: ids } } })
  const sl = await p.stockLevel.deleteMany({ where: { productId: { in: ids } } })
  const cl = await p.channelListing.deleteMany({ where: { productId: { in: ids } } })
  const pr = await p.product.deleteMany({ where: { id: { in: ids } } })
  console.log('deleted:', JSON.stringify({ products: pr.count, listings: cl.count, stock: sl.count, queue: q.count, audit: a.count, ops: b.count, priceEvents: pce.count, skus: prods.map(x => x.sku) }))
  console.log('positive control (must be 0):', await p.product.count({ where: { sku: { startsWith: SKU } } }))
  await p.$disconnect(); process.exit(0)
}
const existing = await p.product.findFirst({ where: { sku: SKU }, select: { id: true } })
if (existing) { console.log('exists:', existing.id); await p.$disconnect(); process.exit(0) }
const loc = await p.stockLocation.findFirstOrThrow({ where: { code: 'IT-MAIN' }, select: { id: true } })
const root = await p.product.create({ data: { workspaceId: WS, sku: SKU, name: 'MX.1 disposable fixture — DELETE ME', status: 'DRAFT', isParent: true, productType: 'AUTO_ACCESSORY', familyId: 'cmtny45st0033njfbhlsr7kg2', variationAxes: ['Size'], basePrice: 50, fulfillmentMethod: 'FBM' }, select: { id: true } })
const kids: Array<{ id: string; size: string; qty: number }> = []
for (const [size, qty] of [['S', 10], ['M', 4]] as const) {
  const c = await p.product.create({ data: { workspaceId: WS, sku: `${SKU}-${size}`, name: `MX.1 fixture ${size}`, status: 'DRAFT', isParent: false, parentId: root.id, productType: 'AUTO_ACCESSORY', familyId: 'cmtny45st0033njfbhlsr7kg2', variantAttributes: { Size: size }, categoryAttributes: { variations: { Size: size } }, basePrice: 50, fulfillmentMethod: 'FBM', totalStock: qty }, select: { id: true } })
  await p.stockLevel.create({ data: { workspaceId: WS, locationId: loc.id, productId: c.id, quantity: qty, reserved: 0, available: qty } })
  kids.push({ id: c.id, size, qty })
}
const coords = [['AMAZON', 'IT', 'cmothu9bo0000nz01asw6wx8j'], ['AMAZON', 'DE', 'cmothu9bo0000nz01asw6wx8j'], ['EBAY', 'IT', 'cmr4aaqb00025nz016k18rup9']] as const
let n = 0
for (const pid of [root.id, ...kids.map(k => k.id)]) for (const [ch, mk, conn] of coords) {
  await p.channelListing.create({ data: { workspaceId: WS, productId: pid, channel: ch, marketplace: mk, region: mk, channelMarket: `${ch}_${mk}`, channelConnectionId: conn, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, followMasterQuantity: true, followMasterPrice: true, fulfillmentMethod: pid === root.id ? null : 'FBM', platformAttributes: { productType: 'AUTO_ACCESSORY' } } })
  n++
}
console.log(JSON.stringify({ rootId: root.id, children: kids, listings: n }))
await p.$disconnect()
