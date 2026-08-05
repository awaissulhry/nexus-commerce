const { default: prisma } = await import('../src/db.js')
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } },
  select: { productId: true, channel: true, marketplace: true, product: { select: { sku: true, parentId: true } } },
})
const memberships = await prisma.sharedListingMembership.findMany({
  where: { status: 'ACTIVE' },
  select: { sku: true, marketplace: true, productId: true },
})
const pids = [...new Set([...listings.map(l=>l.productId), ...memberships.map(m=>m.productId).filter(Boolean) as string[]])]
const prods = await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, sku: true, parentId: true } })
const parentOf = new Map(prods.map(p=>[p.id, p.parentId]))
const skuOf = new Map(prods.map(p=>[p.id, p.sku]))
const masterOf = (pid: string) => parentOf.get(pid) ?? pid
// rows in emission order
type R = { lane: 'LISTING'|'SHARED', sku: string, pid: string, ch: string, mkt: string }
const rows: R[] = []
for (const l of listings) rows.push({ lane:'LISTING', sku: l.product?.sku ?? '?', pid: l.productId, ch: l.channel, mkt: l.marketplace })
for (const m of memberships) if (m.productId) rows.push({ lane:'SHARED', sku: m.sku, pid: m.productId, ch:'EBAY', mkt: m.marketplace })
// group by master (approximation of canonical: use masterOf then fold childless by stem)
const stem = (s: string) => s.trim().replace(/^(IT|DE|FR|ES|UK|EU)-/i,'').replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i,'').replace(/-(ALT\d*|FBM|FBA)$/i,'').toUpperCase()
const masterIds = [...new Set(rows.map(r=>masterOf(r.pid)))]
const withChildren = new Set((await prisma.product.findMany({ where: { parentId: { in: masterIds } }, select:{parentId:true}, distinct:['parentId'] })).map(p=>p.parentId!))
const canonicalByStem = new Map<string,string>()
for (const id of masterIds) { const s = stem(skuOf.get(id) ?? ''); if (withChildren.has(id) && !canonicalByStem.has(s)) canonicalByStem.set(s, id) }
const canon = (id: string) => withChildren.has(id) ? id : (canonicalByStem.get(stem(skuOf.get(id) ?? '')) ?? id)
const byGroup = new Map<string, R[]>()
for (const r of rows) { const g = canon(masterOf(r.pid)); const a = byGroup.get(g) ?? []; a.push(r); byGroup.set(g, a) }
for (const [g, rs] of byGroup) {
  const variantPids = new Set(rs.map(r=>r.pid))
  if (variantPids.size <= 20) continue
  const first12 = rs.slice(0,12)
  const shared = rs.filter(r=>r.lane==='SHARED').length
  console.log(`\nGROUP ${skuOf.get(g)} total=${rs.length} listing=${rs.length-shared} shared=${shared} variants=${variantPids.size}`)
  console.log('  first12 lanes:', first12.map(r=>r.lane[0]).join(''))
  first12.forEach((r,i)=>console.log(`   ${i+1} ${r.lane} ${r.sku} ${r.ch}/${r.mkt}`))
}
await prisma.$disconnect()
