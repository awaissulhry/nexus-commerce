const { default: prisma } = await import('../src/db.js')

const listingWhere = { channel: 'EBAY', marketplace: 'DE' }
const hasListing = { channelListings: { some: listingWhere } }
const prods = await prisma.product.findMany({
  where: { deletedAt: null, OR: [hasListing, { parent: hasListing }, { children: { some: hasListing } }] },
  select: { id: true, sku: true, parentId: true, categoryAttributes: true, channelListings: { where: { channel: 'EBAY' }, select: { region: true, marketplace: true, flatFileSnapshot: true } } },
})
console.log('DE-scope products:', prods.length)
for (const p of prods) {
  const de = p.channelListings.find((c) => c.region === 'DE')
  const snap = (de?.flatFileSnapshot ?? {}) as Record<string, unknown>
  const aspects = Object.entries(snap).filter(([k, v]) => k.startsWith('aspect_') && v !== '' && v != null)
  console.log(p.sku, '| DE listing:', !!de, '| mp:', de?.marketplace, '| cat:', snap.ebay_category ?? snap.category ?? '(none)', '| non-empty aspects:', aspects.map(([k, v]) => `${k}=${String(v).slice(0, 18)}`).join(' ; '))
}
await prisma.$disconnect()
