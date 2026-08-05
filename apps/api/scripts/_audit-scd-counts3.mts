/* READ-ONLY: per-product page — listings SHOWN (group) vs listings EXPORTED (masterId scope) */
const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, externalListingId: true },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true, itemId: true } })
type R = { productId: string | null }
const rows: R[] = [...listings.map((l) => ({ productId: l.productId })), ...mems.map((m) => ({ productId: m.productId }))]
const pids = [...new Set(rows.map((r) => r.productId).filter(Boolean) as string[])]
const prods = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, sku: true, parentId: true } })
const parentOf = new Map(prods.map((p) => [p.id, p.parentId]))
const masterOf = new Map(prods.map((p) => [p.id, p.parentId ?? p.id]))
const masterIds = [...new Set(pids.map((p) => masterOf.get(p)!))]
const kids = await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] })
const withKids = new Set(kids.map((k) => k.parentId!))
const skuOf = new Map((await prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]))
function stem(s: string) { return s.trim().replace(/^(IT|DE|FR|ES|UK|EU)-/i, '').replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '').replace(/-(ALT\d*|FBM|FBA)$/i, '').toUpperCase() }
const canonByStem = new Map<string, string>()
for (const m of masterIds) { const s = stem(skuOf.get(m) ?? ''); if (withKids.has(m) && !canonByStem.has(s)) canonByStem.set(s, m) }
const childless = masterIds.filter((m) => !withKids.has(m))
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const itemIdsBy = new Map<string, string[]>()
for (const c of cls) { const a = itemIdsBy.get(c.productId) ?? []; a.push(c.externalListingId!); itemIdsBy.set(c.productId, a) }
const allIds = [...new Set(cls.map((c) => c.externalListingId!))]
const mem2 = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: allIds } }, select: { itemId: true, productId: true } })
const memPids = [...new Set(mem2.map((m) => m.productId).filter(Boolean) as string[])]
const memProd = await prisma.product.findMany({ where: { id: { in: memPids } }, select: { id: true, parentId: true } })
const mo = new Map(memProd.map((p) => [p.id, p.parentId ?? p.id]))
const canonByItem = new Map<string, string>()
for (const m of mem2) { if (!m.productId || canonByItem.has(m.itemId)) continue; const c = mo.get(m.productId); if (c && withKids.has(c)) canonByItem.set(m.itemId, c) }
const canonOf = new Map<string, string>()
for (const m of masterIds) {
  if (withKids.has(m)) { canonOf.set(m, m); continue }
  let r = m
  for (const it of itemIdsBy.get(m) ?? []) { const c = canonByItem.get(it); if (c && c !== m) { r = c; break } }
  if (r === m) { const c = canonByStem.get(stem(skuOf.get(m) ?? '')); if (c && c !== m) r = c }
  canonOf.set(m, r)
}
const shown = new Map<string, number>()
for (const r of rows) { if (!r.productId) continue; const g = canonOf.get(masterOf.get(r.productId)!)!; shown.set(g, (shown.get(g) ?? 0) + 1) }
// export scope: productId === masterId OR parentId === masterId
const exported = new Map<string, number>()
for (const r of rows) {
  if (!r.productId) continue
  const own = parentOf.get(r.productId) ?? r.productId
  exported.set(own, (exported.get(own) ?? 0) + 1)
}
console.log('group  |  shown-on-page  |  exported-by-masterId  |  missing')
for (const [g, n] of [...shown].sort((a, b) => b[1] - a[1])) {
  const e = exported.get(g) ?? 0
  console.log(`${(skuOf.get(g) ?? g).padEnd(34)} shown=${String(n).padStart(4)}  export=${String(e).padStart(4)}  MISSING=${n - e}`)
}
await prisma.$disconnect()
