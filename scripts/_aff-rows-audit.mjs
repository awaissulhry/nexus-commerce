// READ-ONLY: what the Amazon flat-file editor actually shows.
// 1) Hits GET /api/amazon/flat-file/rows (the same data getExistingRows feeds
//    the grid) for IT, summarises parent/child structure + Color/Size fill.
// 2) Cross-checks AMAZON ChannelListing coverage per family (a family with no
//    AMAZON ChannelListing never appears in the editor).
// Writes NOTHING.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const prisma = new PrismaClient()

const MK = process.argv[2] ?? 'IT'

// ── 1. flat-file rows as the editor sees them ────────────────────────────────
console.log(`\n=== /amazon/flat-file/rows?marketplace=${MK} ===`)
const res = await fetch(`${API}/api/amazon/flat-file/rows?marketplace=${MK}`)
if (!res.ok) { console.error(`HTTP ${res.status}`, await res.text()); process.exit(1) }
const { rows } = await res.json()
console.log(`total rows: ${rows.length}`)

const pl = (r) => String(r.parentage_level ?? '').toLowerCase()
const parents = rows.filter((r) => pl(r) === 'parent')
const children = rows.filter((r) => pl(r) === 'child')
const neither = rows.filter((r) => pl(r) !== 'parent' && pl(r) !== 'child')
console.log(`parents=${parents.length}  children=${children.length}  unmarked=${neither.length}`)

const colorKeys = ['color', 'color_name']
const sizeKeys = ['size', 'size_name', 'apparel_size']
const val = (r, keys) => { for (const k of keys) { const v = r[k]; if (v != null && String(v).trim()) return String(v).trim() } return '' }

console.log(`\n--- families (by parent_sku) ---`)
const fam = new Map()
for (const r of rows) {
  const key = pl(r) === 'parent' ? String(r.item_sku ?? '') : String(r.parent_sku ?? r.item_sku ?? '')
  if (!fam.has(key)) fam.set(key, { parent: null, kids: [] })
  if (pl(r) === 'parent') fam.get(key).parent = r
  else fam.get(key).kids.push(r)
}
for (const [key, f] of [...fam.entries()].sort()) {
  const types = [...new Set([f.parent, ...f.kids].filter(Boolean).map((r) => String(r.product_type ?? '∅')))]
  const kidsNoColor = f.kids.filter((k) => !val(k, colorKeys)).length
  const kidsNoSize = f.kids.filter((k) => !val(k, sizeKeys)).length
  const pTitle = f.parent ? (String(f.parent.item_name ?? f.parent.title ?? '').slice(0, 40)) : '⚠️ NO PARENT ROW'
  console.log(`● ${key}  kids=${f.kids.length}  types=[${types.join(',')}]${types.length > 1 ? ' ⚠️MIXED' : ''}  noColor=${kidsNoColor}  noSize=${kidsNoSize}  parent="${pTitle}"`)
}

// ── 2. AMAZON ChannelListing coverage per family ─────────────────────────────
console.log(`\n=== AMAZON ChannelListing coverage ===`)
const products = await prisma.product.findMany({
  select: { id: true, sku: true, isParent: true, isMaster: true, parentId: true, productType: true },
})
const byId = new Map(products.map((p) => [p.id, p]))
const childrenOf = new Map()
for (const p of products) if (p.parentId) { (childrenOf.get(p.parentId) ?? childrenOf.set(p.parentId, []).get(p.parentId)).push(p) }
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON' },
  select: { productId: true, marketplace: true, status: true },
})
const amzByProduct = new Map()
for (const c of cls) { if (!amzByProduct.has(c.productId)) amzByProduct.set(c.productId, []); amzByProduct.get(c.productId).push(c) }

const parentsAll = products.filter((p) => p.isParent || p.isMaster || (childrenOf.get(p.id)?.length ?? 0) > 0)
for (const p of parentsAll.sort((a, b) => (a.sku > b.sku ? 1 : -1))) {
  const kids = childrenOf.get(p.id) ?? []
  const pListings = amzByProduct.get(p.id) ?? []
  const kidsWithAmz = kids.filter((k) => (amzByProduct.get(k.id) ?? []).length > 0).length
  const mks = [...new Set(pListings.map((l) => l.marketplace))].join(',')
  const flag = pListings.length === 0 && kidsWithAmz === 0 ? '  ⚠️ NOT IN AMAZON EDITOR (no AMAZON ChannelListing)' : ''
  console.log(`${p.sku}  parentAMZlistings=${pListings.length}[${mks}]  kids=${kids.length}  kidsWithAMZ=${kidsWithAmz}${flag}`)
}

await prisma.$disconnect()
