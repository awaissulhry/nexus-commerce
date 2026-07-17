// Delete AIREON old-parent orphaned listings + hard-delete retired products
// (GIACCA, PANTALONI, AIR-MESH COPY). Full backup first. FK-safe fallback:
// if a product hard-delete is blocked by history, keep it soft-deleted (its
// orphaned listings are already removed, which solves the visible problem).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'
const SKUS = ['XAVIA-AIREON-GIACCA-DA','XAVIA-AIREON-PANTALONI-MOTO','AIR-MESH-JACKET-MEN-OLD-COPY-gj062c']

const prods = await prisma.product.findMany({ where:{ sku:{in:SKUS} },
  select:{ id:true, sku:true, deletedAt:true, channelListings:true } })
const backup = { products: prods }
console.log('Targets:')
for (const p of prods) console.log(`  ${p.sku}  softDeleted=${!!p.deletedAt}  listings=${p.channelListings.length}`)
const listingIds = prods.flatMap(p=>p.channelListings.map(c=>c.id))
console.log(`Orphaned listings to delete: ${listingIds.length}`)

if(!APPLY){ console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
const bf = path.join(here, `_backup-cleanup-orphans-${Date.now()}.json`)
fs.writeFileSync(bf, JSON.stringify(backup, null, 2)); console.log(`Backup: ${bf}`)

// 1. delete orphaned listings
if (listingIds.length) { const r = await prisma.channelListing.deleteMany({ where:{ id:{in:listingIds} } }); console.log(`Deleted ${r.count} orphaned listings.`) }

// 2. hard-delete products with FK fallback
for (const p of prods) {
  try { await prisma.product.delete({ where:{ id:p.id } }); console.log(`Hard-deleted product ${p.sku}`) }
  catch (e) { console.log(`⚠️ ${p.sku}: hard-delete blocked (${String(e.message).split('\n')[0].slice(0,80)}) — kept soft-deleted (listings already removed)`)
    if(!p.deletedAt) await prisma.product.update({ where:{id:p.id}, data:{ deletedAt:new Date(), status:'INACTIVE' } }) }
}
await prisma.$disconnect()
console.log('\n✅ Cleanup done.')
