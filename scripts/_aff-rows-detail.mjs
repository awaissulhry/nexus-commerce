// READ-ONLY: dump key flat-file cells for specific families + AMAZON
// ChannelListing marketplace coverage. Writes NOTHING.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const prisma = new PrismaClient()
const MK = process.argv[2] ?? 'IT'
const FOCUS = process.argv.slice(3) // parent SKUs to dump in detail

const res = await fetch(`${API}/api/amazon/flat-file/rows?marketplace=${MK}`)
const { rows } = await res.json()
const pl = (r) => String(r.parentage_level ?? '').toLowerCase()

const fields = ['item_sku', 'parentage_level', 'parent_sku', 'product_type', 'item_name', 'color_name', 'color', 'size_name', 'size', 'apparel_size', 'variation_theme', 'standard_price', 'list_price', 'quantity', 'external_product_id']
for (const focus of FOCUS) {
  console.log(`\n========== FAMILY ${focus} (${MK}) ==========`)
  const fam = rows.filter((r) => String(r.item_sku ?? '') === focus || String(r.parent_sku ?? '') === focus)
  for (const r of fam.sort((a, b) => (pl(a) === 'parent' ? -1 : 1))) {
    const cells = fields.map((f) => `${f}=${r[f] ?? '∅'}`).join('  ')
    console.log(`  ${cells}`)
  }
}

// Marketplace coverage (corrected field names: channel + channelMarket + listingStatus)
console.log(`\n=== AMAZON ChannelListing marketplace coverage (per family) ===`)
const products = await prisma.product.findMany({ select: { id: true, sku: true, isParent: true, isMaster: true, parentId: true } })
const childrenOf = new Map()
for (const p of products) if (p.parentId) { if (!childrenOf.has(p.parentId)) childrenOf.set(p.parentId, []); childrenOf.get(p.parentId).push(p) }
const cls = await prisma.channelListing.findMany({ where: { channel: 'AMAZON' }, select: { productId: true, channelMarket: true, listingStatus: true } })
const byProd = new Map()
for (const c of cls) { if (!byProd.has(c.productId)) byProd.set(c.productId, []); byProd.get(c.productId).push(c) }
const parentsAll = products.filter((p) => p.isParent || p.isMaster || (childrenOf.get(p.id)?.length ?? 0) > 0)
for (const p of parentsAll.sort((a, b) => (a.sku > b.sku ? 1 : -1))) {
  const kids = childrenOf.get(p.id) ?? []
  const kidMks = new Set()
  let kidsWith = 0
  for (const k of kids) { const ls = byProd.get(k.id) ?? []; if (ls.length) kidsWith++; ls.forEach((l) => kidMks.add(l.channelMarket ?? '∅')) }
  console.log(`${p.sku}  kids=${kids.length} kidsWithAMZ=${kidsWith}  childMarkets=[${[...kidMks].sort().join(',')}]`)
}
await prisma.$disconnect()
