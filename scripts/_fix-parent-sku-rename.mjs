// Rename parent SKUs to match Amazon + fix child flatFileSnapshot.parent_sku.
// Backup first. Apply only when argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'

const RENAMES = [
  { from: 'AIR-MESH-JACKET-MEN-OLD', to: 'AIR-MESH-JACKET-MEN' },
  { from: 'XAVIA-MODEL1-COPPIA-DI',  to: 'normal-knee-slider' },
]

const backup = { parents: [], snapshots: [] }
const ops = []
for (const r of RENAMES) {
  const parent = await prisma.product.findUnique({ where: { sku: r.from }, select: { id: true, sku: true } })
  if (!parent) { console.log(`⚠️ ${r.from}: not found — skip`); continue }
  const collision = await prisma.product.findUnique({ where: { sku: r.to }, select: { id: true } })
  if (collision) { console.log(`⚠️ ${r.to}: SKU already exists — ABORT rename`); continue }
  const kids = await prisma.product.findMany({ where: { parentId: parent.id }, select: { id: true, sku: true } })
  const cls = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', productId: { in: kids.map(k=>k.id) } },
    select: { id: true, productId: true, channelMarket: true, flatFileSnapshot: true },
  })
  const skuByPid = new Map(kids.map(k=>[k.id,k.sku]))
  const snapFixes = cls.filter(l => { const s = l.flatFileSnapshot; return s && typeof s==='object' && s.parent_sku === r.from })
    .map(l => ({ listingId: l.id, sku: skuByPid.get(l.productId), market: l.channelMarket, newSnap: { ...l.flatFileSnapshot, parent_sku: r.to } }))
  console.log(`${r.from} -> ${r.to}   kids=${kids.length}  snapshotsToFix=${snapFixes.length}`)
  backup.parents.push({ id: parent.id, from: r.from, to: r.to })
  for (const sf of snapFixes) backup.snapshots.push({ listingId: sf.listingId, before: r.from })
  ops.push({ parentId: parent.id, to: r.to, snapFixes })
}

if (!APPLY) { console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
const bf = path.join(here, `_backup-parent-rename-${Date.now()}.json`)
fs.writeFileSync(bf, JSON.stringify(backup, null, 2))
console.log(`\nRollback backup: ${bf}`)
for (const op of ops) {
  await prisma.product.update({ where: { id: op.parentId }, data: { sku: op.to } })
  for (const sf of op.snapFixes) await prisma.channelListing.update({ where: { id: sf.listingId }, data: { flatFileSnapshot: sf.newSnap } })
  console.log(`✅ Renamed -> ${op.to} (+${op.snapFixes.length} snapshots)`)
}
await prisma.$disconnect()
