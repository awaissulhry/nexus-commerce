// READ-ONLY: compare LIVE Amazon parent families (from Seller Central, provided
// by operator) against our DB parent structure. Highlights ASIN gaps + AIREON split.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

// Ground truth from Seller Central (operator-provided): parentSku -> {asin, vars}
const AMZ = {
  'AIR-MESH-JACKET-MEN': { asin: 'B0FXCDEDCA', vars: 6 },
  'xavia-knee-slider':   { asin: 'B0FXCC827B', vars: 8 },
  'normal-knee-slider':  { asin: 'B0C3YRQPFT', vars: 8 },
  '1J-EYE5-Y0TW':        { asin: 'B0FX749EA8', vars: 5 },
  'UD-LVLM-1H8T':        { asin: 'B0FX023BCD', vars: 10 },
  'xracing':             { asin: 'B0FX521367', vars: 49 },
  '3K-HP05-BH9I':        { asin: 'B0FXBC7417', vars: 15 },
  'WATERPROOF-OVERJACKET-BLACK-MEN': { asin: 'B0FX908898', vars: 6 },
  'AIREON':              { asin: 'B0FX10086B', vars: 24 },
  'GALE-JACKET':         { asin: 'B0FXD0620C', vars: 20 },
  'AIRMESH-JACKET':      { asin: 'B0DYXSQP18', vars: 12 },
  'IT-MOSS-JACKET':      { asin: 'B0FX8A5E82', vars: 21 },
  'REGAL-JACKET':        { asin: 'B0FX5D1762', vars: 24 },
  'VENTRA-JACKET':       { asin: 'B0FX8D94BC', vars: 24 },
}

const all = await prisma.product.findMany({ select: { id: true, sku: true, amazonAsin: true, parentId: true, isParent: true, isMaster: true, status: true } })
const bySku = new Map(all.map(p => [p.sku, p]))
const kidsOf = new Map()
for (const p of all) if (p.parentId) { if (!kidsOf.has(p.parentId)) kidsOf.set(p.parentId, []); kidsOf.get(p.parentId).push(p) }

console.log('AMZ parentSku                       | AMZ ASIN     | #var | DB match? | DB ASIN      | DB kids | note')
console.log('-'.repeat(120))
for (const [sku, info] of Object.entries(AMZ)) {
  const db = bySku.get(sku)
  const dbKids = db ? (kidsOf.get(db.id)?.length ?? 0) : 0
  const dbAsin = db?.amazonAsin ?? '∅'
  let note = ''
  if (!db) note = '⚠️ NO DB PRODUCT with this SKU'
  else if (dbAsin === '∅') note = '⚠️ DB missing ASIN (backfill ' + info.asin + ')'
  else if (dbAsin !== info.asin) note = `⚠️ ASIN MISMATCH (db ${dbAsin})`
  else note = '✓ asin ok'
  if (db && dbKids !== info.vars) note += `  ⚠️ kids ${dbKids}≠${info.vars}`
  console.log(`${sku.padEnd(34)} | ${info.asin} | ${String(info.vars).padStart(4)} | ${(db?'yes':'NO ').padEnd(9)} | ${dbAsin.padEnd(12)} | ${String(dbKids).padStart(7)} | ${note}`)
}

console.log('\n=== AIREON detail (DB currently splits into 2 parents) ===')
for (const sku of ['AIREON','XAVIA-AIREON-GIACCA-DA','XAVIA-AIREON-PANTALONI-MOTO']) {
  const p = bySku.get(sku)
  if (!p) { console.log(`  ${sku}: (no DB product)`); continue }
  console.log(`  ${sku}: id=${p.id} asin=${p.amazonAsin??'∅'} isParent=${p.isParent} kids=${kidsOf.get(p.id)?.length ?? 0} status=${p.status}`)
}
await prisma.$disconnect()
