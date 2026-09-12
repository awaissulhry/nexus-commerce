import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
import { resolveAttributes } from '../src/services/pim/attribute-resolver.js'

const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-BLACK-MEN-L' } })!
const listings = await prisma.channelListing.findMany({
  where: { productId: p!.id }, select: { channel: true, marketplace: true, overrideData: true, titleOverride: true },
})
console.log('listings on GALE-JACKET:', listings.map(l => `${l.channel}·${l.marketplace}`).join(', '))

const master = resolveAttributes({ product: p as any, parent: null, locale: 'en' })
console.log('\nkeys where a CHANNEL scope differs from MASTER (proves per-coordinate resolution):')
let found = 0
for (const l of listings) {
  const ch = resolveAttributes({ product: p as any, parent: null, channelListing: l as any, locale: 'it' })
  for (const k of Object.keys(ch)) {
    const a = JSON.stringify(master[k]?.value)?.slice(0, 40)
    const b = JSON.stringify(ch[k]?.value)?.slice(0, 40)
    if (a !== b) {
      console.log(`  ${l.channel}·${l.marketplace} ${k}: master=${a} (${master[k]?.source})  channel=${b} (${ch[k]?.source})`)
      found++
    }
  }
}
if (!found) console.log('  (none differ on this product — no per-coordinate overrides set)')
await prisma.$disconnect()
