import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}

// === 1. DB-WIDE stem collisions among CHILD-OWNING masters (latent flapping) ===
const allProducts = await prisma.product.findMany({ select: { id: true, sku: true, parentId: true, name: true } })
const childOwners = new Set(allProducts.map(p => p.parentId).filter(Boolean) as string[])
const stemMap = new Map<string, {id:string;sku:string}[]>()
for (const p of allProducts) {
  if (!childOwners.has(p.id)) continue
  const s = canonicalStem(p.sku)
  stemMap.set(s, [...(stemMap.get(s) ?? []), { id: p.id, sku: p.sku }])
}
console.log('=== 1. DB-wide stem collisions among CHILD-OWNING masters ===')
let coll = 0
for (const [s, arr] of stemMap) if (arr.length > 1) { coll++; console.log('  COLLIDE stem=', s, arr.map(a=>a.sku)) }
console.log('  collisions:', coll, '/ child-owning masters:', childOwners.size)

// === 1b. childless masters whose stem matches a child-owning master's stem, DB-wide ===
console.log('\n=== 1b. ALL childless products whose stem matches a child-owning family stem ===')
for (const p of allProducts) {
  if (childOwners.has(p.id) || p.parentId) continue // only childless top-level masters
  const s = canonicalStem(p.sku)
  const owners = stemMap.get(s)
  if (owners?.length) console.log('  ', p.sku, '(', p.name?.slice(0,40), ') --stem-->', owners.map(o=>o.sku).join('|'))
}

// === 2. AMBIGUOUS POOLS: one itemId whose memberships span >1 canonical master ===
const mems = await prisma.sharedListingMembership.findMany({ select: { itemId: true, productId: true, status: true } })
const prodParent = new Map(allProducts.map(p => [p.id, p.parentId ?? p.id]))
const byItem = new Map<string, Set<string>>()
for (const m of mems) {
  if (!m.productId) continue
  const mm = prodParent.get(m.productId)
  if (!mm || !childOwners.has(mm)) continue
  byItem.set(m.itemId, (byItem.get(m.itemId) ?? new Set()).add(mm))
}
console.log('\n=== 2. itemIds pooling >1 child-owning canonical (first-wins => non-deterministic) ===')
let amb = 0
const skuById = new Map(allProducts.map(p => [p.id, p.sku]))
for (const [itemId, set] of byItem) if (set.size > 1) { amb++; console.log('  itemId', itemId, '->', [...set].map(s=>skuById.get(s))) }
console.log('  ambiguous itemIds:', amb, '/', byItem.size)

// === 3. childless masters with >1 externalListingId resolving to different canonicals ===
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] } }, select: { productId: true },
})
const memsA = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = [...new Set([...listings.map(l=>l.productId), ...memsA.map(m=>m.productId).filter(Boolean) as string[]])]
const masterIds = [...new Set(rowPids.map(id => prodParent.get(id) ?? id))]
const childless = masterIds.filter(id => !childOwners.has(id))
const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const byMasterItems = new Map<string,string[]>()
for (const c of cls) byMasterItems.set(c.productId, [...(byMasterItems.get(c.productId) ?? []), c.externalListingId!])
console.log('\n=== 3. childless master whose listings resolve to DIFFERENT canonicals (order-dependent) ===')
for (const [mid, items] of byMasterItems) {
  const targets = new Set<string>()
  for (const it of items) { const s = byItem.get(it); if (s) for (const t of s) targets.add(t) }
  if (targets.size > 1) console.log('  ', skuById.get(mid), 'items', items, '->', [...targets].map(t=>skuById.get(t)))
  else if (items.length > 1) console.log('  (ok, single target)', skuById.get(mid), items.length, 'listings ->', [...targets].map(t=>skuById.get(t)))
}

// === 4. variantCount inflation: folded masters counted as "variants" ===
console.log('\n=== 4. variantCount inflation per group (folded masters appear as variant pids) ===')
// replicate grouping quickly (pool then stem)
const stemOfMaster = new Map<string,string>(); const canonicalByStem = new Map<string,string>()
const msk = allProducts.filter(p => masterIds.includes(p.id))
for (const m of msk) { const s = canonicalStem(m.sku); stemOfMaster.set(m.id, s); if (childOwners.has(m.id) && !canonicalByStem.has(s)) canonicalByStem.set(s, m.id) }
const canonicalOf = new Map<string,string>()
for (const mid of masterIds) {
  if (childOwners.has(mid)) { canonicalOf.set(mid, mid); continue }
  let r = mid
  for (const it of byMasterItems.get(mid) ?? []) { const s = byItem.get(it); if (s) { const t = [...s][0]; if (t !== mid) { r = t; break } } }
  if (r === mid) { const c = canonicalByStem.get(stemOfMaster.get(mid) ?? '\0'); if (c && c !== mid) r = c }
  canonicalOf.set(mid, r)
}
const groupOfPid = (pid: string) => { const m = prodParent.get(pid) ?? pid; return canonicalOf.get(m) ?? m }
const pidsByGroup = new Map<string, Set<string>>()
for (const pid of rowPids) { const g = groupOfPid(pid); pidsByGroup.set(g, (pidsByGroup.get(g) ?? new Set()).add(pid)) }
for (const [g, pids] of pidsByGroup) {
  const realChildren = [...pids].filter(p => prodParent.get(p) === g && p !== g).length
  const selfMasters = [...pids].filter(p => (prodParent.get(p) ?? p) !== g || p === g)
  const foldedMasters = [...pids].filter(p => canonicalOf.get(p) === g && p !== g && childOwners.has(g) && !childOwners.has(p) && !allProducts.find(x=>x.id===p)?.parentId)
  if (foldedMasters.length) console.log('  ', skuById.get(g), 'variantCount reported =', pids.size, ' real children in rows =', realChildren, ' inflated by folded masters:', foldedMasters.map(f=>skuById.get(f)))
}

// === 5. export mismatch: detail page rows vs export rows for a folded group ===
console.log('\n=== 5. detail-page rows vs Excel-export rows (masterId=canonical) ===')
for (const [g, pids] of pidsByGroup) {
  const exportPids = new Set(allProducts.filter(p => p.id === g || p.parentId === g).map(p=>p.id))
  const missing = [...pids].filter(p => !exportPids.has(p))
  if (missing.length) console.log('  ', skuById.get(g), ': page shows pids', pids.size, ' export covers', [...pids].filter(p=>exportPids.has(p)).length, ' MISSING', missing.map(m=>skuById.get(m)))
}

await prisma.$disconnect()
