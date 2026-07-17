// _inv-alloc-00-scope.mjs — READ-ONLY. Scope the per-channel allocation need:
// do multiple FBM channels actually compete for the warehouse pool today?
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()
const MERCHANT = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

// 1) Amazon listing fulfillment split
const amz = await prisma.channelListing.groupBy({
  by: ['fulfillmentMethod'], where: { channel: 'AMAZON' }, _count: true,
})
console.log('Amazon listings by fulfillmentMethod:', JSON.stringify(amz.map((a) => ({ fm: a.fulfillmentMethod ?? '(null)', n: a._count }))))

// 2) listings per channel
const byChannel = await prisma.channelListing.groupBy({ by: ['channel'], _count: true })
console.log('Listings by channel:', JSON.stringify(byChannel.map((c) => ({ ch: c.channel, n: c._count }))))

// 3) Offer rail usage
const offerTotal = await prisma.offer.count().catch(() => 'n/a')
const offerWithQty = await prisma.offer.count({ where: { quantity: { not: null } } }).catch(() => 'n/a')
console.log(`Offer rows: ${offerTotal}  (with quantity set: ${offerWithQty})`)

// 4) StockLocation types
const locs = await prisma.stockLocation.groupBy({ by: ['type'], _count: true })
console.log('StockLocation types:', JSON.stringify(locs.map((l) => ({ type: l.type, n: l._count }))))

// 5) products with 2+ FBM channels competing for warehouse
const products = await prisma.product.findMany({
  select: {
    sku: true, fulfillmentMethod: true,
    channelListings: { select: { channel: true, fulfillmentMethod: true } },
  },
})
let multiFbm = 0
const examples = []
for (const p of products) {
  const fbmChannels = new Set()
  for (const cl of p.channelListings) {
    const isFbm = MERCHANT.has(cl.channel) || (cl.channel === 'AMAZON' && cl.fulfillmentMethod === 'FBM')
    if (isFbm) fbmChannels.add(cl.channel + (cl.channel === 'AMAZON' ? '-FBM' : ''))
  }
  if (fbmChannels.size >= 2) {
    multiFbm++
    if (examples.length < 12) examples.push(`${p.sku}: ${[...fbmChannels].join(' + ')}`)
  }
}
console.log(`\nProducts with 2+ FBM channels (warehouse competition → allocation needed): ${multiFbm} / ${products.length}`)
for (const e of examples) console.log('  ' + e)
await prisma.$disconnect()
