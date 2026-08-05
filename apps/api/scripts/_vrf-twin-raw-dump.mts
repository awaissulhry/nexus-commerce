const { default: prisma } = await import('../src/db.js')
const { axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: any): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const show = (label: string, snap: any) => {
  if (!isObj(snap)) return
  const ent = Object.entries(snap).filter(([k, v]) => k.startsWith('aspect_') && typeof v === 'string' && v)
  const dims = ent.filter(([k]) => axisSynonymKey(k.slice(7).replace(/_/g, ' ')).startsWith('__dim'))
  if (dims.length) console.log(label, JSON.stringify(Object.fromEntries(dims)))
}
for (const m of await prisma.sharedListingMembership.findMany({ where: { OR: [{ parentSku: { contains: 'GALE' } }, { sku: { contains: 'GALE' } }] }, select: { sku: true, marketplace: true, parentSku: true, itemId: true, status: true, flatFileSnapshot: true, variationSpecifics: true } })) {
  show(`MEMB ${m.marketplace} ${m.parentSku}/${m.sku} item=${m.itemId} ${m.status}`, m.flatFileSnapshot)
}
for (const c of await prisma.channelListing.findMany({ where: { channel: 'EBAY', product: { OR: [{ sku: { contains: 'WATERPROOF' } }, { sku: { contains: 'GALE' } }, { sku: { contains: 'TEST' } }] } }, select: { marketplace: true, flatFileSnapshot: true, platformAttributes: true, product: { select: { sku: true } } } })) {
  show(`CL ${c.marketplace} ${c.product?.sku}`, c.flatFileSnapshot)
  const its = (c.platformAttributes as any)?.itemSpecifics
  if (isObj(its)) {
    const dims = Object.entries(its).filter(([k]) => axisSynonymKey(k).startsWith('__dim'))
    if (dims.length) console.log(`  ITEMSPECS ${c.marketplace} ${c.product?.sku}`, JSON.stringify(Object.fromEntries(dims)))
  }
}
await prisma.$disconnect()
