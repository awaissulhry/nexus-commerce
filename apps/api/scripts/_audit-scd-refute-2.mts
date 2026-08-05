const { default: prisma } = await import('../src/db.js')

const master = await prisma.product.findFirst({
  where: { sku: 'WATERPROOF-OVERJACKET-BLACK-MEN' },
  select: { id: true, sku: true, name: true, parentId: true, fulfillmentMethod: true },
})
console.log('MASTER', master)

const ls = await prisma.channelListing.findMany({
  where: { productId: master!.id },
  select: { channel: true, marketplace: true, isPublished: true, listingStatus: true, quantity: true, externalListingId: true, followMasterQuantity: true },
})
console.log('--- master own listings ---')
for (const l of ls) console.log(JSON.stringify(l))

const lv = await prisma.stockLevel.findMany({
  where: { productId: master!.id },
  select: { available: true, quantity: true, location: { select: { code: true, type: true } } },
})
console.log('--- master stock levels ---')
for (const l of lv) console.log(JSON.stringify(l))

const kids = await prisma.product.findMany({ where: { parentId: master!.id }, select: { id: true, sku: true } })
const kidLv = await prisma.stockLevel.findMany({
  where: { productId: { in: kids.map(k => k.id) }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true },
})
const poolByKid = new Map<string, number>()
for (const l of kidLv) poolByKid.set(l.productId, (poolByKid.get(l.productId) ?? 0) + l.available)
let sum = 0, inStock = 0
for (const k of kids) { const p = poolByKid.get(k.id) ?? 0; sum += p; if (p > 0) inStock++ }
console.log(`children=${kids.length} childPool=${sum} childInStock=${inStock}`)

// how many child pids actually appear in rows
const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { productId: true } })
const rowPids = new Set<string>([...listings.map(l => l.productId), ...mems.map(m => m.productId).filter((x): x is string => Boolean(x))])
console.log('children present in rows:', kids.filter(k => rowPids.has(k.id)).length)
await prisma.$disconnect()
