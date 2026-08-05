const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, marketplace: true, flatFileSnapshot: true, product: { select: { sku: true } } },
})
const byMkt = new Map<string, Map<string, number>>()
for (const cl of cls) {
  const snap = cl.flatFileSnapshot as any
  if (!snap || typeof snap !== 'object') continue
  const m = cl.marketplace || '?'
  if (!byMkt.has(m)) byMkt.set(m, new Map())
  const bag = byMkt.get(m)!
  for (const k of Object.keys(snap)) if (k.startsWith('aspect_')) bag.set(k, (bag.get(k) ?? 0) + 1)
}
for (const [m, bag] of [...byMkt].sort()) {
  console.log('\n=== MARKET', m, '===')
  console.log([...bag].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '))
}
const mem = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { marketplace: true, flatFileSnapshot: true } })
const byM2 = new Map<string, Map<string, number>>()
for (const x of mem) {
  const snap = x.flatFileSnapshot as any
  if (!snap || typeof snap !== 'object') continue
  const m = x.marketplace || '?'
  if (!byM2.has(m)) byM2.set(m, new Map())
  const bag = byM2.get(m)!
  for (const k of Object.keys(snap)) if (k.startsWith('aspect_')) bag.set(k, (bag.get(k) ?? 0) + 1)
}
for (const [m, bag] of [...byM2].sort()) {
  console.log('\n=== MEMBERSHIP MARKET', m, '===')
  console.log([...bag].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '))
}
await prisma.$disconnect()
