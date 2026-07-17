// _inv-legacy-totalstock.mjs — READ-ONLY. Characterise products whose totalStock
// is NOT backed by a WAREHOUSE StockLevel row (legacy feed-set). After the 1.1
// fix, a stock movement on these recomputes totalStock=0 → pushes out-of-stock.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()

const products = await prisma.product.findMany({
  select: {
    sku: true, totalStock: true, isParent: true, parentId: true, deletedAt: true,
    stockLevels: { select: { quantity: true, location: { select: { type: true } } } },
    channelListings: { select: { channel: true, listingStatus: true, followMasterQuantity: true, isPublished: true } },
  },
})

const legacy = products.filter((p) => !p.deletedAt && p.totalStock > 0
  && !p.stockLevels.some((s) => s.location?.type === 'WAREHOUSE'))

const groups = {}
let withLiveListings = 0
const exposed = []
for (const p of legacy) {
  let g = 'other'
  if (/_FBM$/.test(p.sku)) g = 'underscore_*_FBM'
  else if (/^xracing/i.test(p.sku)) g = 'xracing*'
  else if (/MISANO/i.test(p.sku)) g = 'MISANO'
  else if (/VENTRA/i.test(p.sku)) g = 'VENTRA'
  else if (/AIREON/i.test(p.sku)) g = 'AIREON'
  else if (/GALE/i.test(p.sku)) g = 'GALE'
  groups[g] = (groups[g] ?? 0) + 1
  const live = p.channelListings.filter((c) => c.followMasterQuantity && c.isPublished
    && (c.listingStatus === 'ACTIVE' || c.listingStatus === 'BUYABLE'))
  if (live.length) { withLiveListings++; if (exposed.length < 20) exposed.push({ sku: p.sku, totalStock: p.totalStock, live: live.map((c) => `${c.channel}:${c.listingStatus}`).join(',') }) }
}

console.log(`\nTotal products: ${products.length}`)
console.log(`Legacy (totalStock>0, NO warehouse StockLevel): ${legacy.length}`)
console.log('By SKU pattern:', JSON.stringify(groups, null, 2))
console.log(`\nLEGACY w/ LIVE published+followMaster listings (would push out-of-stock on a stock movement): ${withLiveListings}`)
console.log('Exposed sample:')
for (const e of exposed) console.log(`  ${e.sku}  totalStock=${e.totalStock}  live=[${e.live}]`)
await prisma.$disconnect()
