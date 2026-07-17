// Update stale flatFileSnapshot.parent_sku on AIREON children from the old split
// parents to 'AIREON'. Backup first. Apply only when argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'
const OLD = new Set(['XAVIA-AIREON-GIACCA-DA', 'XAVIA-AIREON-PANTALONI-MOTO'])

const aireon = await prisma.product.findUnique({ where: { sku: 'AIREON' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: aireon.id }, select: { id: true, sku: true } })
const skuByPid = new Map(kids.map(k=>[k.id,k.sku]))
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', productId: { in: kids.map(k=>k.id) } },
  select: { id: true, productId: true, channelMarket: true, flatFileSnapshot: true },
})
const backup = [], plan = []
for (const l of cls) {
  const snap = l.flatFileSnapshot
  if (snap && typeof snap === 'object' && OLD.has(snap.parent_sku)) {
    backup.push({ listingId: l.id, sku: skuByPid.get(l.productId), market: l.channelMarket, beforeParentSku: snap.parent_sku })
    plan.push({ listingId: l.id, sku: skuByPid.get(l.productId), market: l.channelMarket, newSnap: { ...snap, parent_sku: 'AIREON' } })
  }
}
console.log(`Snapshots to fix: ${plan.length}`)
for (const p of plan.slice(0,5)) console.log(`  ${p.sku} [${p.market}]  parent_sku -> AIREON`)
if (plan.length>5) console.log(`  … +${plan.length-5} more`)
if (!APPLY) { console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
const bf = path.join(here, `_backup-aireon-snap-${Date.now()}.json`)
fs.writeFileSync(bf, JSON.stringify(backup, null, 2))
console.log(`\nRollback backup: ${bf}`)
let n=0
for (const p of plan) { await prisma.channelListing.update({ where: { id: p.listingId }, data: { flatFileSnapshot: p.newSnap } }); n++ }
console.log(`✅ Updated ${n} snapshots.`)
await prisma.$disconnect()
