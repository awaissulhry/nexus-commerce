// READ-ONLY: for the two broken families, determine the exact write target —
// does each AMAZON child listing have a flatFileSnapshot (which overrides), and
// does platformAttributes.attributes carry color/size? Compare to variantAttributes.
// Writes NOTHING.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const FAMILIES = ['GALE-JACKET-FBM', '1J-EYE5-Y0TW', 'GALE-JACKET'] // last = healthy reference

for (const famSku of FAMILIES) {
  const parent = await prisma.product.findUnique({ where: { sku: famSku }, select: { id: true, sku: true } })
  if (!parent) { console.log(`\n### ${famSku}: NOT FOUND`); continue }
  const kids = await prisma.product.findMany({
    where: { parentId: parent.id },
    select: { id: true, sku: true, variantAttributes: true },
    orderBy: { sku: 'asc' },
  })
  const ids = [parent.id, ...kids.map((k) => k.id)]
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', productId: { in: ids } },
    select: { productId: true, channelMarket: true, platformAttributes: true, flatFileSnapshot: true, title: true },
  })
  // index listings by product per market
  const byProd = new Map()
  for (const l of listings) { if (!byProd.has(l.productId)) byProd.set(l.productId, []); byProd.get(l.productId).push(l) }

  console.log(`\n### FAMILY ${famSku} — parent has ${(byProd.get(parent.id) ?? []).length} AMZ listings; ${kids.length} children`)
  // Sample first 2 children for detail
  for (const k of kids.slice(0, 2)) {
    const ls = byProd.get(k.id) ?? []
    console.log(`  child ${k.sku}  variantAttributes=${k.variantAttributes ? JSON.stringify(k.variantAttributes) : '∅'}  listings=${ls.length}`)
    for (const l of ls) {
      const a = (l.platformAttributes?.attributes ?? {})
      const color = a.color?.[0]?.value ?? '∅'
      const size = a.size?.[0]?.value ?? a.apparel_size?.[0]?.value ?? a.size_name?.[0]?.value ?? '∅'
      const snap = l.flatFileSnapshot && typeof l.flatFileSnapshot === 'object' ? Object.keys(l.flatFileSnapshot).length : 0
      const snapColor = snap ? (l.flatFileSnapshot.color ?? l.flatFileSnapshot.color_name ?? '∅') : '—'
      const snapSize = snap ? (l.flatFileSnapshot.size ?? l.flatFileSnapshot.size_name ?? l.flatFileSnapshot.apparel_size ?? '∅') : '—'
      console.log(`     [${l.channelMarket}] attrs.color=${color} attrs.size=${size} | snapshot=${snap ? snap + ' keys' : 'NONE'} snap.color=${snapColor} snap.size=${snapSize} | title="${String(l.title ?? '').slice(0, 30)}"`)
    }
  }
  // Aggregate: how many child listings have a snapshot vs not; how many have attrs.color
  let withSnap = 0, withAttrColor = 0, total = 0
  for (const k of kids) {
    for (const l of byProd.get(k.id) ?? []) {
      total++
      const snap = l.flatFileSnapshot && typeof l.flatFileSnapshot === 'object' && Object.keys(l.flatFileSnapshot).length > 0
      if (snap) withSnap++
      const a = (l.platformAttributes?.attributes ?? {})
      if (a.color?.[0]?.value) withAttrColor++
    }
  }
  console.log(`  AGG: child listings=${total}  withSnapshot=${withSnap}  withAttrs.color=${withAttrColor}`)
}
await prisma.$disconnect()
