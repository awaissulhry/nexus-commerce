import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
import { resolveAttributes } from '../src/services/pim/attribute-resolver.js'

const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' } })
if (!p) { console.log('not found'); process.exit(1) }
console.log('=== the stored columns ===')
console.log('  Product.brand        :', JSON.stringify(p.brand))
console.log('  Product.manufacturer :', JSON.stringify(p.manufacturer))
const ca = (p.categoryAttributes ?? {}) as Record<string, unknown>
console.log('  categoryAttributes.brand        :', JSON.stringify(ca.brand))
console.log('  categoryAttributes.manufacturer :', JSON.stringify(ca.manufacturer))

console.log('\n=== resolveAttributes with NO listing (what master scope uses) ===')
const master = resolveAttributes({ product: p as any, parent: null, locale: 'en' })
console.log('  brand        :', JSON.stringify(master.brand?.value), ' source=', master.brand?.source)
console.log('  manufacturer :', JSON.stringify(master.manufacturer?.value), ' source=', master.manufacturer?.source)

console.log('\n=== resolveAttributes WITH the Amazon·IT listing (channel scope) ===')
const listing = await prisma.channelListing.findFirst({ where: { productId: p.id, channel: 'AMAZON', marketplace: 'IT' } })
if (listing) {
  const ch = resolveAttributes({ product: p as any, parent: null, channelListing: listing as any, locale: 'it' })
  console.log('  brand        :', JSON.stringify(ch.brand?.value), ' source=', ch.brand?.source)
} else console.log('  (no AMAZON·IT listing)')

console.log('\n=== what the SHEET shows for the brand column ===')
const { buildSheetRows } = await import('../src/services/pim/sheet-rows.service.js').catch(() => ({ buildSheetRows: null as any }))
console.log('  sheet-rows resolves master with: resolveAttributes({ product, parent, locale })  [sheet-rows.service.ts:397]')
console.log('  → therefore the sheet and a master formula read the SAME map; any difference is in')
console.log('    which KEY each displays, not which resolver ran.')
await prisma.$disconnect()
