// _aff-attr-dump.mjs — READ-ONLY. Dump what's actually stored on Amazon
// ChannelListings: platformAttributes shape, presence of the reportedly-missing
// attributes, flatFileSnapshot, and the bullet override toggle. Grounds the
// flat-file persistence/fetch investigation in real data.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()

const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', externalListingId: { not: null } },
  select: {
    marketplace: true, externalListingId: true, listingStatus: true,
    followMasterBulletPoints: true, bulletPointsOverride: true,
    platformAttributes: true, flatFileSnapshot: true,
    product: { select: { sku: true, countryOfOrigin: true, bulletPoints: true } },
  },
  take: 6,
})

const PROBE = ['bullet_point', 'fabric_type', 'country_of_origin', 'supplier_declared_dangerous_goods', 'material', 'item_name']

for (const cl of cls) {
  const pa = (cl.platformAttributes ?? {})
  const attrs = pa.attributes ?? pa
  const ff = cl.flatFileSnapshot ?? null
  console.log('\n────────────────────────────────────────')
  console.log(`${cl.product.sku}  ${cl.marketplace}  ASIN=${cl.externalListingId}  status=${cl.listingStatus}`)
  console.log('  Product.countryOfOrigin:', JSON.stringify(cl.product.countryOfOrigin ?? '(null)'))
  console.log('  Product.bulletPoints:', Array.isArray(cl.product.bulletPoints) ? `${cl.product.bulletPoints.length} bullets` : JSON.stringify(cl.product.bulletPoints ?? '(null)'))
  console.log('  followMasterBulletPoints:', cl.followMasterBulletPoints, '  bulletPointsOverride:', JSON.stringify(cl.bulletPointsOverride ?? '(null)'))
  console.log('  platformAttributes top-level keys:', Object.keys(pa).join(', ') || '(empty)')
  console.log('  attributes keys (' + (attrs ? Object.keys(attrs).length : 0) + '):', attrs ? Object.keys(attrs).slice(0, 40).join(', ') : '(none)')
  for (const k of PROBE) {
    console.log(`    • ${k}:`, attrs && attrs[k] !== undefined ? JSON.stringify(attrs[k]).slice(0, 200) : '(ABSENT)')
  }
  console.log('  flatFileSnapshot:', ff ? `${Object.keys(ff).length} cols → ${Object.keys(ff).slice(0, 30).join(',')}` : '(none)')
}
console.log(`\nScanned ${cls.length} Amazon listings.`)
await prisma.$disconnect()
