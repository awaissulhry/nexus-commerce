// _inv-split-14-fmethod.mjs — Phase 1.3 backfill.
// Persist ChannelListing.fulfillmentMethod where NULL, but only when the
// FBA/FBM signal is clear (labels only — no quantity change, safe for all):
//   • merchant channels (eBay/Shopify/Woo/Etsy)        -> FBM
//   • Amazon w/ FBA stock bucket>0 OR product=FBA        -> FBA
//   • Amazon w/ product=FBM (no FBA signal)              -> FBM
//   • Amazon w/ no signal at all                         -> leave NULL (runtime derives)
// DRY RUN by default. Pass --apply to write.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()
const MERCHANT_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

const listings = await prisma.channelListing.findMany({
  where: { fulfillmentMethod: null },
  select: {
    id: true, channel: true, marketplace: true,
    product: {
      select: {
        sku: true, fulfillmentMethod: true,
        stockLevels: { select: { quantity: true, location: { select: { type: true } } } },
      },
    },
  },
})

const changes = []
let leftNull = 0
for (const cl of listings) {
  let method = null
  if (MERCHANT_CHANNELS.has(cl.channel)) {
    method = 'FBM'
  } else if (cl.channel === 'AMAZON') {
    const fbaBucket = cl.product.stockLevels.filter((s) => s.location?.type === 'AMAZON_FBA').reduce((a, s) => a + s.quantity, 0)
    if (fbaBucket > 0 || cl.product.fulfillmentMethod === 'FBA') method = 'FBA'
    else if (cl.product.fulfillmentMethod === 'FBM') method = 'FBM'
  }
  if (!method) { leftNull++; continue }
  changes.push({ cl, method })
}

const byBucket = {}
for (const { cl, method } of changes) {
  const k = `${cl.channel}->${method}`
  byBucket[k] = (byBucket[k] ?? 0) + 1
}

console.log(`\n${APPLY ? 'APPLY' : 'DRY-RUN'} — Phase 1.3 persist fulfillmentMethod (null -> resolved)`)
console.log(`Listings with null fulfillmentMethod: ${listings.length}`)
console.log(`  to set: ${changes.length}   left NULL (ambiguous): ${leftNull}`)
console.log('  breakdown:', JSON.stringify(byBucket))
const sample = changes.slice(0, 20)
for (const { cl, method } of sample) console.log(`    ${cl.product.sku} ${cl.channel}/${cl.marketplace} -> ${method}`)
if (changes.length > sample.length) console.log(`    … and ${changes.length - sample.length} more`)

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write.')
  await prisma.$disconnect()
  process.exit(0)
}

let n = 0
for (const { cl, method } of changes) {
  await prisma.channelListing.update({ where: { id: cl.id }, data: { fulfillmentMethod: method } })
  n++
}
console.log(`\nApplied. fulfillmentMethod set on ${n} listings.`)
await prisma.$disconnect()
