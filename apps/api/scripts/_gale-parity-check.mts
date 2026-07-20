// READ-ONLY: live variations + quantities on the GALE primary vs pool truth.
import prisma from '../src/db.js'
import { ebayAuthService } from '../src/services/ebay-auth.service.js'
import { callTradingApi, siteIdForMarket } from '../src/services/ebay-trading-api.service.js'
import { parseLiveVariations } from '../src/services/ebay-membership-reconcile.service.js'

const PRIMARY = '257584954808'
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
if (!conn) throw new Error('no connection')
const token = await ebayAuthService.getValidToken(conn.id)
const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${PRIMARY}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`
const got = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket('IT') })
const live = parseLiveVariations(got.raw)
// SellingStatus QuantitySold per variation + Quantity = original listed; available = Quantity - Sold
const varBlocks = [...got.raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map((m) => m[1])
const detail = varBlocks.map((b) => {
  const sku = /<SKU>([^<]*)<\/SKU>/.exec(b)?.[1] ?? ''
  const qty = Number(/<Quantity>(\d+)<\/Quantity>/.exec(b)?.[1] ?? 0)
  const sold = Number(/<QuantitySold>(\d+)<\/QuantitySold>/.exec(b)?.[1] ?? 0)
  return { sku, listed: qty, sold, available: qty - sold }
})
console.log('LIVE variations:', detail.length)
let totalAvail = 0
for (const d of detail.sort((a, b) => a.sku.localeCompare(b.sku))) {
  totalAvail += d.available
  console.log(`  ${d.sku.padEnd(34)} listed=${d.listed} sold=${d.sold} avail=${d.available}`)
}
console.log('TOTAL live available:', totalAvail)

// Pool truth: the 20 canonical children + -REAL twins
const parent = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
const kids = await prisma.product.findMany({
  where: { parentId: parent!.id, deletedAt: null, sku: { not: { contains: '_FBM' } } },
  select: { sku: true, totalStock: true, channelListings: { where: { channel: 'EBAY', region: 'IT' }, select: { quantity: true, stockBuffer: true, externalListingId: true } } },
  orderBy: { sku: 'asc' },
})
let poolTotal = 0
const liveSkus = new Set(detail.map((d) => d.sku))
for (const k of kids) {
  const cl = k.channelListings[0]
  const mark = liveSkus.has(k.sku) ? '' : '  << NOT LIVE on primary'
  if (!k.sku.endsWith('-REAL')) poolTotal += k.totalStock ?? 0
  console.log(`  POOL ${k.sku.padEnd(34)} stock=${String(k.totalStock).padEnd(4)} cl.qty=${cl ? cl.quantity : '—'} buffer=${cl ? cl.stockBuffer : '—'} ext=${cl?.externalListingId ?? '—'}${mark}`)
}
console.log('POOL total (canonical, excl -REAL):', poolTotal)
const reals = await prisma.product.findMany({ where: { sku: { contains: '-REAL' }, deletedAt: null }, select: { sku: true, totalStock: true, parentId: true } })
console.log('REAL products:', JSON.stringify(reals))
const prims = await prisma.sharedListingMembership.findMany({ where: { itemId: PRIMARY }, select: { sku: true, lastQtyPushed: true, status: true } })
console.log('primary memberships:', prims.length, JSON.stringify(prims.map(m => `${m.sku}:${m.lastQtyPushed}:${m.status}`)))
await prisma.$disconnect()
