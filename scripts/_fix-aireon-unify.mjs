// Unify AIREON to match Amazon (parent SKU AIREON / ASIN B0F7RTV2BD / 24 var):
//   1. create a new parent Product "AIREON"
//   2. re-point all 24 children (12 jacket + 12 pant) parentId -> AIREON
//   3. soft-delete the two old parents (GIACCA + PANTALONI)
// Plus 3 parent-ASIN backfills (AIRMESH / AIR-MESH-OLD / MODEL1).
// Full rollback backup written. NO Amazon push. Apply only when argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'

const giacca = await prisma.product.findUnique({ where: { sku: 'XAVIA-AIREON-GIACCA-DA' } })
const pant   = await prisma.product.findUnique({ where: { sku: 'XAVIA-AIREON-PANTALONI-MOTO' } })
const existingAireon = await prisma.product.findUnique({ where: { sku: 'AIREON' }, select: { id: true } })
if (!giacca || !pant) { console.error('AIREON parents not found'); process.exit(1) }
if (existingAireon) { console.error('A product with SKU "AIREON" already exists — aborting to avoid collision'); process.exit(1) }

const kids = await prisma.product.findMany({
  where: { parentId: { in: [giacca.id, pant.id] }, deletedAt: null },
  select: { id: true, sku: true, parentId: true, masterProductId: true, productType: true },
  orderBy: { sku: 'asc' },
})
const jacketKids = kids.filter(k => k.parentId === giacca.id)
const pantKids = kids.filter(k => k.parentId === pant.id)
console.log(`Children: ${kids.length} (jacket ${jacketKids.length} + pant ${pantKids.length})`)

// 3 ASIN backfills
const backfills = [
  { sku: 'AIRMESH-JACKET', asin: 'B0DYXSQP18' },
  { sku: 'AIR-MESH-JACKET-MEN-OLD', asin: 'B0CFBCYN3K' },
  { sku: 'XAVIA-MODEL1-COPPIA-DI', asin: 'B0C3YRQPFT' },
]
const bfRows = []
for (const b of backfills) {
  const p = await prisma.product.findUnique({ where: { sku: b.sku }, select: { id: true, sku: true, amazonAsin: true } })
  if (p) bfRows.push({ ...b, id: p.id, current: p.amazonAsin })
  console.log(`  backfill ${b.sku}: ${p ? `${p.amazonAsin ?? '∅'} -> ${b.asin}` : 'NOT FOUND'}`)
}

console.log(`\nPlan:`)
console.log(`  create parent AIREON (asin B0F7RTV2BD, OUTERWEAR, theme "Body Type / Color / Size", name from GIACCA)`)
console.log(`  re-point ${kids.length} children -> AIREON`)
console.log(`  soft-delete GIACCA (${giacca.id}) + PANTALONI (${pant.id})`)
console.log(`  backfill ${bfRows.length} parent ASINs`)

if (!APPLY) { console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }

const ts = Date.now()
const backup = {
  giacca, pant,
  children: kids,
  backfills: bfRows,
}
const backupFile = path.join(here, `_backup-aireon-unify-${ts}.json`)
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2))
console.log(`\nRollback backup: ${backupFile}`)

// 1. create AIREON
const aireon = await prisma.product.create({
  data: {
    sku: 'AIREON',
    name: giacca.name,
    basePrice: giacca.basePrice,
    brand: giacca.brand, manufacturer: giacca.manufacturer,
    isParent: true, isMaster: true, isMasterProduct: true,
    amazonAsin: 'B0F7RTV2BD',
    productType: 'OUTERWEAR',
    variationTheme: 'Body Type / Color / Size',
    variationAxes: ['Body Type', 'Color', 'Size'],
    status: 'ACTIVE',
    syncChannels: giacca.syncChannels ?? [],
    localizedContent: giacca.localizedContent ?? { en: {}, it: {} },
  },
})
console.log(`Created AIREON id=${aireon.id}`)

// 2. re-point children (parentId + masterProductId where it pointed at an old parent)
let n = 0
for (const k of kids) {
  const data = { parentId: aireon.id }
  if (k.masterProductId === giacca.id || k.masterProductId === pant.id) data.masterProductId = aireon.id
  await prisma.product.update({ where: { id: k.id }, data })
  n++
}
console.log(`Re-pointed ${n} children`)

// 3. soft-delete old parents
await prisma.product.update({ where: { id: giacca.id }, data: { deletedAt: new Date(), isParent: false, status: 'INACTIVE' } })
await prisma.product.update({ where: { id: pant.id },   data: { deletedAt: new Date(), isParent: false, status: 'INACTIVE' } })
console.log(`Soft-deleted GIACCA + PANTALONI`)

// 4. ASIN backfills
for (const b of bfRows) { await prisma.product.update({ where: { id: b.id }, data: { amazonAsin: b.asin } }); console.log(`Backfilled ${b.sku} -> ${b.asin}`) }

await prisma.$disconnect()
console.log('\n✅ Done.')
