import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const aireon = await prisma.product.findUnique({ where: { sku: 'AIREON' }, select: { id: true } })
const kids = await prisma.product.findMany({ where: { parentId: aireon.id }, select: { id: true, sku: true } })
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', productId: { in: kids.map(k=>k.id) } },
  select: { id: true, productId: true, channelMarket: true, flatFileSnapshot: true },
})
const skuByPid = new Map(kids.map(k=>[k.id,k.sku]))
const counts = {}
let withSnap = 0
for (const l of cls) {
  const snap = l.flatFileSnapshot
  if (snap && typeof snap === 'object' && Object.keys(snap).length) {
    withSnap++
    const ps = snap.parent_sku ?? '∅'
    counts[ps] = (counts[ps] ?? 0) + 1
  }
}
console.log(`AIREON child listings=${cls.length}  withSnapshot=${withSnap}`)
console.log('snapshot.parent_sku distribution:', JSON.stringify(counts, null, 1))
// sample 4
for (const l of cls.slice(0,4)) {
  const s = l.flatFileSnapshot ?? {}
  console.log(`  ${skuByPid.get(l.productId)} [${l.channelMarket}]  snap.parent_sku=${s.parent_sku ?? '∅'}  snap.parentage_level=${s.parentage_level ?? '∅'}`)
}
await prisma.$disconnect()
