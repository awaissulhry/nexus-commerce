// READ-ONLY: find every AIREON-related product (incl. soft-deleted) + their
// ChannelListings, to see what still appears as a "separate listing".
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const prods = await prisma.product.findMany({
  where: { OR: [ { sku: { contains: 'AIREON', mode: 'insensitive' } }, { name: { contains: 'AIREON', mode: 'insensitive' } } ] },
  select: { id:true, sku:true, name:true, status:true, deletedAt:true, isParent:true, isMaster:true, parentId:true, amazonAsin:true,
    channelListings: { select: { id:true, channel:true, channelMarket:true, externalListingId:true, listingStatus:true } } },
  orderBy: { sku: 'asc' },
})

// Group: parents/standalone vs children
const parents = prods.filter(p => p.isParent || p.isMaster || !p.parentId)
const kids = prods.filter(p => p.parentId)
console.log(`Total AIREON-matching products: ${prods.length}  (parents/standalone=${parents.length}, children=${kids.length})`)

console.log(`\n=== PARENTS / STANDALONE (the "separate listings" candidates) ===`)
for (const p of parents) {
  const del = p.deletedAt ? `🗑DELETED(${p.deletedAt.toISOString().slice(0,10)})` : 'LIVE'
  const cl = p.channelListings
  console.log(`\n${p.sku}  [${p.status}] ${del}  isParent=${p.isParent} isMaster=${p.isMaster} asin=${p.amazonAsin??'∅'}`)
  console.log(`   "${(p.name??'').slice(0,60)}"`)
  console.log(`   channelListings=${cl.length}`)
  for (const c of cl) console.log(`     ${c.channel}/${c.channelMarket}  ext=${c.externalListingId??'∅'}  status=${c.listingStatus??'∅'}  id=${c.id}`)
}

// child parent distribution
console.log(`\n=== CHILD → parentId distribution ===`)
const dist = {}
for (const k of kids) dist[k.parentId] = (dist[k.parentId]||0)+1
for (const [pid,n] of Object.entries(dist)) {
  const par = prods.find(p=>p.id===pid) || await prisma.product.findUnique({where:{id:pid},select:{sku:true,deletedAt:true}})
  console.log(`   parentId=${pid} (${par?.sku})  children=${n}`)
}
await prisma.$disconnect()
