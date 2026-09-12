import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
import { resolveAttributes } from '../src/services/pim/attribute-resolver.js'
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-BLACK-MEN-L' } })
const l = await prisma.channelListing.findFirst({ where: { productId: p!.id, channel: 'AMAZON', marketplace: 'DE' } })
const master = resolveAttributes({ product: p as any, parent: null, locale: 'en' })
const ch = resolveAttributes({ product: p as any, parent: null, channelListing: l as any, locale: 'de' })
const CHANNEL_LAYERS = new Set(['channelOverride', 'channelExplicit'])
const rows = Object.keys(ch).filter(k => CHANNEL_LAYERS.has(ch[k]?.source as string))
console.log('keys the CHANNEL scope resolves from a channel layer:', rows.length)
for (const k of rows.slice(0, 6)) {
  console.log(`  ${k}: master=${JSON.stringify(master[k]?.value)?.slice(0,34)} (${master[k]?.source})`)
  console.log(`     channel=${JSON.stringify(ch[k]?.value)?.slice(0,34)} (${ch[k]?.source})`)
}
console.log('\n→ master scope never sees a channel layer:',
  Object.keys(master).every(k => !CHANNEL_LAYERS.has(master[k]?.source as string)))
await prisma.$disconnect()
