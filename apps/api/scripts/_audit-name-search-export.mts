const { default: prisma } = await import('../src/db.js')

const needles = ['giacca', 'coppia', 'gale']
const prods = await prisma.product.findMany({ select: { id: true, sku: true, name: true, parentId: true } })
const byId = new Map(prods.map(p => [p.id, p]))

for (const needle of needles) {
  const masters = prods.filter(p => !p.parentId)
  const matchedMasters = masters.filter(m => {
    const kids = prods.filter(c => c.parentId === m.id)
    return m.name.toLowerCase().includes(needle)
      || m.sku.toLowerCase().includes(needle)
      || kids.some(c => c.sku.toLowerCase().includes(needle))
  })
  // rows-ish: every product sku that contains needle (export filter is sku-only)
  const skuHits = prods.filter(p => p.sku.toLowerCase().includes(needle))
  console.log(`\nNEEDLE "${needle}": products-view masters matched = ${matchedMasters.length}; products whose SKU contains needle = ${skuHits.length}`)
  console.log('  sample masters:', matchedMasters.slice(0, 6).map(m => `${m.sku} :: ${m.name.slice(0, 50)}`))
}

// how many masters have names but no sku token overlap at all
console.log('\nsample master names:', prods.filter(p => !p.parentId).slice(0, 15).map(p => `${p.sku} :: ${p.name.slice(0,60)}`))
await prisma.$disconnect()
