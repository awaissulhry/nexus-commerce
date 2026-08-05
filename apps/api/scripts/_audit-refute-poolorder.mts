const { default: prisma } = await import('../src/db.js')

// all masters (parentId null) that appear in sync-control rows domain: approximate with all products having channelListings or memberships
const prods = await prisma.product.findMany({ select: { id: true, sku: true, parentId: true } })
const masters = prods.filter(p => !p.parentId)
const withChildren = new Set(prods.filter(p => p.parentId).map(p => p.parentId!))
const childless = masters.filter(m => !withChildren.has(m.id))
console.log('MASTERS', masters.length, 'childOwning', masters.filter(m=>withChildren.has(m.id)).length, 'childless', childless.length)

const cls = await prisma.channelListing.findMany({ where: { productId: { in: childless.map(c=>c.id) }, externalListingId: { not: null } }, select: { productId: true, externalListingId: true } })
const byMaster = new Map<string,Set<string>>()
for (const c of cls) { if(!c.externalListingId) continue; const s = byMaster.get(c.productId) ?? new Set(); s.add(c.externalListingId); byMaster.set(c.productId, s) }
const multi = [...byMaster.entries()].filter(([,s]) => s.size > 1)
console.log('CHILDLESS MASTERS WITH >1 itemId:', multi.length)
for (const [pid, s] of multi) console.log('  ', prods.find(p=>p.id===pid)?.sku, [...s].join(','))

// ambiguity per itemId across ALL memberships (not just childless)
const allItemIds = [...new Set(cls.map(c=>c.externalListingId!))]
const mems = await prisma.sharedListingMembership.findMany({ where: { itemId: { in: allItemIds } }, select: { itemId: true, productId: true, sku: true } })
const pids = [...new Set(mems.map(m=>m.productId).filter(Boolean) as string[])]
const masterOf = new Map(prods.filter(p=>pids.includes(p.id)).map(p=>[p.id, p.parentId ?? p.id]))
const canonByItem = new Map<string,Set<string>>()
for (const m of mems) { if(!m.productId) continue; const c = masterOf.get(m.productId); if(!c || !withChildren.has(c)) continue; const s = canonByItem.get(m.itemId) ?? new Set(); s.add(c); canonByItem.set(m.itemId, s) }
const ambig = [...canonByItem.entries()].filter(([,s])=>s.size>1)
console.log('ITEMIDS resolving to >1 child-owning canonical:', ambig.length)
for (const [it,s] of ambig) console.log('  ', it, [...s].map(id=>prods.find(p=>p.id===id)?.sku).join(' | '))

// per childless master: how many distinct canonicals across its itemIds
let ambigMaster = 0
for (const [pid, s] of byMaster) {
  const set = new Set<string>()
  for (const it of s) for (const c of (canonByItem.get(it) ?? [])) set.add(c)
  if (set.size > 1) { ambigMaster++; console.log('AMBIG MASTER', prods.find(p=>p.id===pid)?.sku, [...set].map(id=>prods.find(p=>p.id===id)?.sku).join(' | ')) }
}
console.log('CHILDLESS MASTERS resolving to >1 canonical:', ambigMaster)

// how many child-owning masters share a canonical stem (the stem-path ambiguity the sort fixed)
function stem(sku:string){let s=sku.trim();s=s.replace(/^(IT|DE|FR|ES|UK|EU)-/i,'');s=s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i,'');s=s.replace(/-(ALT\d*|FBM|FBA)$/i,'');return s.toUpperCase()}
const stemMap = new Map<string,string[]>()
for (const m of masters) if (withChildren.has(m.id)) { const k = stem(m.sku); stemMap.set(k, [...(stemMap.get(k)??[]), m.sku]) }
const stemAmbig = [...stemMap.entries()].filter(([,v])=>v.length>1)
console.log('STEMS with >1 child-owning master:', stemAmbig.length, JSON.stringify(stemAmbig))
await prisma.$disconnect()
