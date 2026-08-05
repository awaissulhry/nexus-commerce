const { default: prisma } = await import('../src/db.js')
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true, name: true, children: { select: { sku: true, name: true } } } })
for (const q of ['giacca','giubbotto','ventilata','gale','air']) {
  const n = q.toLowerCase()
  const byName = masters.filter(m => m.name.toLowerCase().includes(n))
  const bySku = masters.filter(m => m.sku.toLowerCase().includes(n) || m.children.some(c => c.sku.toLowerCase().includes(n)))
  const bothOnlyName = byName.filter(m => !bySku.includes(m))
  console.log(`q="${q}" byName=${byName.length} bySku=${bySku.length} nameOnly=${bothOnlyName.length}`)
  if (bothOnlyName.length) console.log('   e.g.', bothOnlyName.slice(0,3).map(m => `${m.sku} :: ${m.name}`).join(' | '))
}
// how many listing rows exist total (ChannelListing) with sku containing giacca
const cl = await prisma.channelListing.count()
const clG = await prisma.channelListing.count({ where: { sku: { contains: 'giacca', mode: 'insensitive' } } })
console.log('channelListings total', cl, 'sku~giacca', clG)
await prisma.$disconnect()
