// Backfill GALE-JACKET-FBM children's platformAttributes.color/size from the
// matching-ASIN FBA sibling (GALE-JACKET), per market. Writes a rollback backup
// first. Does NOT push to Amazon. Apply only when argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'

const fbm = await prisma.product.findUnique({ where: { sku: 'GALE-JACKET-FBM' }, select: { id: true } })
const fba = await prisma.product.findUnique({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const fbmKids = await prisma.product.findMany({ where: { parentId: fbm.id }, select: { id: true, sku: true, amazonAsin: true } })
const fbaKids = await prisma.product.findMany({ where: { parentId: fba.id }, select: { id: true, sku: true, amazonAsin: true } })
const fbaIdByAsin = new Map(fbaKids.filter(k => k.amazonAsin).map(k => [k.amazonAsin, k.id]))

// FBA sibling listings keyed by (fbaProductId, channelMarket)
const fbaListings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', productId: { in: fbaKids.map(k => k.id) } },
  select: { productId: true, channelMarket: true, platformAttributes: true },
})
const fbaByKey = new Map()
for (const l of fbaListings) fbaByKey.set(`${l.productId}|${l.channelMarket}`, l.platformAttributes)

// FBM child listings to fix
const fbmListings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', productId: { in: fbmKids.map(k => k.id) } },
  select: { id: true, productId: true, channelMarket: true, platformAttributes: true },
})
const skuByPid = new Map(fbmKids.map(k => [k.id, k.sku]))
const asinByPid = new Map(fbmKids.map(k => [k.id, k.amazonAsin]))

const VARIATION_KEYS = ['color', 'size', 'size_name', 'apparel_size', 'color_name']
const backup = []
const plan = []
for (const l of fbmListings) {
  const asin = asinByPid.get(l.productId)
  const fbaPid = asin ? fbaIdByAsin.get(asin) : null
  const sib = fbaPid ? fbaByKey.get(`${fbaPid}|${l.channelMarket}`) : null
  const sibAttrs = (sib?.attributes ?? {})
  const cur = (l.platformAttributes ?? {})
  const curAttrs = (cur.attributes ?? {})
  const copied = {}
  for (const k of VARIATION_KEYS) if (sibAttrs[k] != null && !(curAttrs[k]?.[0]?.value)) copied[k] = sibAttrs[k]
  if (Object.keys(copied).length === 0) continue
  const newAttrs = { ...curAttrs, ...copied }
  const newPA = { ...cur, attributes: newAttrs }
  backup.push({ listingId: l.id, sku: skuByPid.get(l.productId), market: l.channelMarket, before: l.platformAttributes })
  plan.push({ listingId: l.id, sku: skuByPid.get(l.productId), market: l.channelMarket,
    color: copied.color?.[0]?.value, size: (copied.size ?? copied.size_name ?? copied.apparel_size)?.[0]?.value, newPA })
}

console.log(`Listings to update: ${plan.length} / ${fbmListings.length}`)
for (const p of plan.slice(0, 8)) console.log(`  ${p.sku} [${p.market}]  color=${p.color ?? '∅'} size=${p.size ?? '∅'}`)
if (plan.length > 8) console.log(`  … +${plan.length - 8} more`)

if (!APPLY) { console.log('\nDRY-RUN (pass "apply" to write). No changes made.'); await prisma.$disconnect(); process.exit(0) }

const backupFile = path.join(here, `_backup-gale-fbm-${Date.now()}.json`)
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2))
console.log(`\nRollback backup written: ${backupFile}`)
let n = 0
for (const p of plan) { await prisma.channelListing.update({ where: { id: p.listingId }, data: { platformAttributes: p.newPA } }); n++ }
console.log(`✅ Updated ${n} listings.`)
await prisma.$disconnect()
