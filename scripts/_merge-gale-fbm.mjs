// Merge GALE-JACKET-FBM into GALE-JACKET as one family (FBA + FBM sub-groups).
// Re-parent the 18 FBM children -> GALE-JACKET, fix their snapshot.parent_sku,
// delete the FBM parent's own (unpublished) listings, hard-delete the FBM parent.
// Child Amazon listings are UNTOUCHED (FBM stays live). Backup first.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'

const fba = await prisma.product.findUnique({ where:{ sku:'GALE-JACKET' }, select:{ id:true } })
const fbm = await prisma.product.findUnique({ where:{ sku:'GALE-JACKET-FBM' }, select:{ id:true } })
if (!fba || !fbm) { console.error('GALE parents not found'); process.exit(1) }

const kids = await prisma.product.findMany({ where:{ parentId: fbm.id }, select:{ id:true, sku:true, parentId:true, masterProductId:true } })
const fbmParent = await prisma.product.findUnique({ where:{ id: fbm.id }, select:{ id:true, sku:true, channelListings:true } })
// FBM children snapshots referencing the old parent sku
const kidListings = await prisma.channelListing.findMany({ where:{ productId:{in:kids.map(k=>k.id)} }, select:{ id:true, productId:true, flatFileSnapshot:true } })
const snapFixes = kidListings.filter(l => { const s=l.flatFileSnapshot; return s && typeof s==='object' && s.parent_sku==='GALE-JACKET-FBM' })

console.log(`FBM children to re-parent: ${kids.length}`)
console.log(`FBM parent own listings to delete: ${fbmParent.channelListings.length}`)
console.log(`Child snapshots needing parent_sku fix: ${snapFixes.length}`)

if (!APPLY) { console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
const backup = { fbmParent, children: kids, fbmParentListings: fbmParent.channelListings, snapFixes: snapFixes.map(s=>({id:s.id,before:'GALE-JACKET-FBM'})) }
const bf = path.join(here, `_backup-merge-gale-fbm-${Date.now()}.json`)
fs.writeFileSync(bf, JSON.stringify(backup, null, 2)); console.log(`Backup: ${bf}`)

// 1. re-parent children (+ masterProductId if it pointed at the FBM parent)
let n=0
for (const k of kids) { const data={ parentId: fba.id }; if (k.masterProductId===fbm.id) data.masterProductId=fba.id; await prisma.product.update({ where:{id:k.id}, data }); n++ }
console.log(`Re-parented ${n} children -> GALE-JACKET`)
// 2. fix snapshots
for (const s of snapFixes) { await prisma.channelListing.update({ where:{id:s.id}, data:{ flatFileSnapshot:{ ...s.flatFileSnapshot, parent_sku:'GALE-JACKET' } } }) }
console.log(`Fixed ${snapFixes.length} snapshots`)
// 3. delete FBM parent's own listings + hard-delete the parent
if (fbmParent.channelListings.length) { const r=await prisma.channelListing.deleteMany({ where:{ id:{in:fbmParent.channelListings.map(c=>c.id)} } }); console.log(`Deleted ${r.count} FBM-parent listings`) }
try { await prisma.product.delete({ where:{ id: fbm.id } }); console.log('Hard-deleted GALE-JACKET-FBM parent') }
catch(e){ console.log(`⚠️ FBM parent hard-delete blocked (${String(e.message).split('\n')[0].slice(0,70)}); soft-deleting instead`); await prisma.product.update({ where:{id:fbm.id}, data:{ deletedAt:new Date(), status:'INACTIVE', isParent:false } }) }
await prisma.$disconnect()
console.log('\n✅ Merge done.')
