// Check current state of XS siblings vs XXS on Amazon (from ChannelListing in DB)
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
const J = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v } }
const first = (a) => Array.isArray(a) && a[0] ? (a[0].value ?? JSON.stringify(a[0])) : (a ?? '—')

const SKUS = ['GALE-JACKET-BLACK-MEN-XS', 'GALE-JACKET-BLACK-MEN-XXS', 'GALE-JACKET-YELLOW-MEN-XS', 'GALE-JACKET-YELLOW-MEN-XXS']

for (const sku of SKUS) {
  const prod = await p.product.findFirst({
    where: { sku },
    select: { id: true, amazonAsin: true, fnsku: true, variantAttributes: true, categoryAttributes: true },
  })
  if (!prod) { console.log(`${sku}: NOT FOUND`); continue }
  const va = J(prod.variantAttributes)||{}; const cv = (J(prod.categoryAttributes)||{}).variations||{}
  console.log(`\n── ${sku} ──`)
  console.log(`  nexus: asin=${prod.amazonAsin??'—'} fnsku=${prod.fnsku??'—'} Size=${va.Size??cv.Size??'—'} Color=${va.Color??cv.Color??'—'}`)
  const listings = await p.channelListing.findMany({
    where: { productId: prod.id, channel: 'AMAZON' },
    select: { marketplace: true, listingStatus: true, externalListingId: true, platformAttributes: true },
    orderBy: { marketplace: 'asc' },
  })
  for (const l of listings) {
    const a = (J(l.platformAttributes)||{}).attributes||{}
    const sizeAttr = JSON.stringify(a.size??a.apparel_size??'—').slice(0, 60)
    const parentage = (a.parentage_level??[])
    const hasParent = Array.isArray(parentage) && parentage.length > 0 ? parentage[0].value : '—'
    const msa = (a.merchant_suggested_asin??[])
    const msaVal = Array.isArray(msa) && msa.length > 0 ? msa[0].value : '—'
    console.log(`  [${l.marketplace}] extId=${l.externalListingId??'—'} status=${l.listingStatus} size=${sizeAttr} parentage=${hasParent} MSA=${msaVal}`)
  }
}

await p.$disconnect()
