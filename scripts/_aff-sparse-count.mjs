// _aff-sparse-count.mjs — READ-ONLY. How many Amazon listings are "sparse"
// (missing key required attrs in platformAttributes AND no flatFileSnapshot),
// i.e. would show blank in the editor and need hydration from Amazon.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()

const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', externalListingId: { not: null } },
  select: { marketplace: true, listingStatus: true, platformAttributes: true, flatFileSnapshot: true, product: { select: { sku: true } } },
})

const KEY = ['bullet_point', 'fabric_type', 'country_of_origin']
let total = 0, hydrated = 0, sparse = 0, hasSnapshot = 0
const sparseExamples = []
for (const cl of cls) {
  total++
  const attrs = (cl.platformAttributes?.attributes ?? cl.platformAttributes ?? {})
  const present = KEY.filter((k) => attrs && attrs[k] !== undefined).length
  const snap = !!cl.flatFileSnapshot && Object.keys(cl.flatFileSnapshot).length > 0
  if (snap) hasSnapshot++
  if (present === KEY.length || snap) { hydrated++ }
  else {
    sparse++
    if (sparseExamples.length < 15) sparseExamples.push(`${cl.product.sku} ${cl.marketplace} (${cl.listingStatus}, ${present}/${KEY.length} key attrs, snapshot=${snap})`)
  }
}
console.log(`\nAmazon listings: ${total}`)
console.log(`  hydrated (full key attrs or snapshot): ${hydrated}`)
console.log(`  with flatFileSnapshot: ${hasSnapshot}`)
console.log(`  SPARSE (blank in editor → need hydration): ${sparse}`)
console.log('\nSparse examples:')
for (const e of sparseExamples) console.log('  ' + e)
await prisma.$disconnect()
