const { default: prisma } = await import('../src/db.js')
const prods = await prisma.product.findMany({ select: { id: true, sku: true, name: true, parentId: true } })
const masters = prods.filter(p => !p.parentId)
let broken: string[] = []
for (const m of masters) {
  const needle = m.sku.toLowerCase()
  const kids = prods.filter(c => c.parentId === m.id)
  const skuHits = prods.filter(p => p.sku.toLowerCase().includes(needle))
  if (skuHits.length === 0) broken.push(`${m.sku} (kids=${kids.length})`)
}
console.log('masters whose OWN sku matches no product sku at all:', broken.length)
// children sku prefix check for a few known masters
for (const s of ['IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'AIREON-ALT1']) {
  const m = masters.find(x => x.sku === s)
  if (!m) continue
  const kids = prods.filter(c => c.parentId === m.id).map(c => c.sku)
  console.log(s, '->kids', kids.slice(0, 4), 'count', kids.length)
}
await prisma.$disconnect()
