/** READ-ONLY forensic: is VENTRA's STORED eBay data clean (Colore,Taglia) or does it
 * physically carry ghost colour columns? Distinguishes "display artifact" from "DB issue".
 * No writes anywhere. */
import prisma from '../src/db.js'

const J = (v: unknown) => JSON.stringify(v)
const isObj = (o: unknown): o is Record<string, unknown> =>
  !!o && typeof o === 'object' && !Array.isArray(o)
const keysOf = (o: unknown) => (isObj(o) ? Object.keys(o) : [])
const colorish = (k: string) => /colo|gener|adatto|taglia|size|team|athlete|body/i.test(k)

console.log('=== VENTRA READ-BACK FORENSICS (READ-ONLY) ===')

// ---------- 1. Products (catalog truth) ----------
const prods = await prisma.product.findMany({
  where: { sku: { startsWith: 'VENTRA' }, deletedAt: null },
  select: {
    id: true, sku: true, isParent: true, parentId: true,
    variationTheme: true, variationAxes: true,
    variantAttributes: true, categoryAttributes: true,
  },
  orderBy: { sku: 'asc' },
})
console.log('\n[Products] count =', prods.length)
for (const p of prods.filter((p) => p.isParent || !p.parentId)) {
  console.log('  PARENT', p.sku, 'theme=', J(p.variationTheme), 'variationAxes=', J(p.variationAxes))
}
const vaKeys = new Set<string>(), caVarKeys = new Set<string>()
const attrVals: Record<string, Set<string>> = {}
for (const p of prods) {
  for (const k of keysOf(p.variantAttributes)) vaKeys.add(k)
  const caVar = isObj(p.categoryAttributes) ? (p.categoryAttributes as Record<string, unknown>).variations : null
  for (const k of keysOf(caVar)) caVarKeys.add(k)
  const merged = { ...(isObj(p.variantAttributes) ? p.variantAttributes : {}), ...(isObj(caVar) ? caVar : {}) }
  for (const [k, v] of Object.entries(merged)) if (colorish(k)) (attrVals[k] ??= new Set()).add(String(v))
}
console.log('  child variantAttributes keys:', J([...vaKeys]))
console.log('  child categoryAttributes.variations keys:', J([...caVarKeys]))
console.log('  colour/size/gender attr VALUES across children:')
for (const [k, s] of Object.entries(attrVals)) console.log('     ', k, `(${s.size})`, '=>', J([...s].sort()))

// ---------- 2. ChannelListings (eBay Lane-A + snapshots) ----------
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: prods.map((p) => p.id) }, channel: 'EBAY' },
  select: {
    externalListingId: true, marketplace: true, channelMarket: true,
    variationTheme: true, platformAttributes: true, flatFileSnapshot: true,
  },
})
console.log('\n[ChannelListings EBAY] count =', cls.length)
for (const c of cls) {
  const pa = isObj(c.platformAttributes) ? c.platformAttributes : {}
  const snap = isObj(c.flatFileSnapshot) ? c.flatFileSnapshot : {}
  console.log('  CL', c.externalListingId || '(no itemId)', c.marketplace || c.channelMarket)
  console.log('     theme=', J(c.variationTheme), ' _variationAxes=', J((pa as Record<string, unknown>)._variationAxes))
  console.log('     itemSpecifics keys=', J(keysOf((pa as Record<string, unknown>).itemSpecifics)))
  console.log('     snapshot.variation_theme=', J((snap as Record<string, unknown>).variation_theme))
  console.log('     snapshot aspect_ keys=', J(keysOf(snap).filter((k) => k.startsWith('aspect_'))))
}

// ---------- 3. SharedListingMemberships (Lane-B / live read-back store) ----------
const memb = await prisma.sharedListingMembership.findMany({
  where: { OR: [{ parentSku: { startsWith: 'VENTRA' } }, { sku: { startsWith: 'VENTRA' } }] },
  select: { itemId: true, sku: true, parentSku: true, marketplace: true, status: true, variationSpecifics: true, flatFileSnapshot: true },
})
console.log('\n[SharedListingMemberships] count =', memb.length)
const byItem: Record<string, typeof memb> = {}
for (const m of memb) (byItem[m.itemId] ??= []).push(m)
console.log('  distinct listings (itemIds) =', Object.keys(byItem).length)

const vsKeys = new Set<string>()
const vsVals: Record<string, Set<string>> = {}
for (const m of memb) {
  for (const [k, v] of Object.entries(isObj(m.variationSpecifics) ? m.variationSpecifics : {})) {
    vsKeys.add(k)
    if (colorish(k)) (vsVals[k] ??= new Set()).add(String(v))
  }
}
console.log('  variationSpecifics KEYS stored (the "live axes"):', J([...vsKeys]))
console.log('  variationSpecifics colour/size VALUES:')
for (const [k, s] of Object.entries(vsVals)) console.log('     ', k, `(${s.size})`, '=>', J([...s].sort()))

for (const [item, rows] of Object.entries(byItem)) {
  const skus = new Set(rows.map((r) => r.sku))
  const statuses = new Set(rows.map((r) => r.status))
  const snapAspect = new Set<string>()
  for (const r of rows) for (const k of keysOf(r.flatFileSnapshot)) if (k.startsWith('aspect_')) snapAspect.add(k)
  console.log(`   itemId ${item} [${rows[0]?.marketplace}]: ${rows.length} memberships, ${skus.size} distinct SKUs, status=${J([...statuses])}`)
  console.log(`        snapshot aspect_ keys: ${J([...snapAspect])}`)
}

console.log('\n=== END (no writes performed) ===')
await prisma.$disconnect()
