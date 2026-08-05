/* READ-ONLY audit probe 2 — cartesian blast radius + export/grid filter divergence. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// --- 1) Cartesian (productIds x markets) blast radius on the per-product page.
// Real example: the GALE group's AMAZON listings.
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, sku: true } })
if (!gale) throw new Error('no GALE-JACKET')
const galeKids = await prisma.product.findMany({ where: { parentId: gale.id }, select: { id: true, sku: true } })
const kidIds = galeKids.map((k) => k.id)
const amz = await prisma.channelListing.findMany({
  where: { productId: { in: kidIds }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, marketplace: true, quantity: true, followMasterQuantity: true, product: { select: { sku: true } } },
  orderBy: [{ marketplace: 'asc' }],
})
const byPid = new Map<string, string[]>()
for (const a of amz) { const arr = byPid.get(a.productId) ?? []; arr.push(a.marketplace); byPid.set(a.productId, arr) }
console.log('GALE AMAZON published listings:', amz.length, 'across', new Set(amz.map((a) => a.marketplace)).size, 'markets')
const two = [...byPid.entries()].filter(([, ms]) => ms.length > 1).slice(0, 3)
console.log('sample products with >1 market:', two.map(([pid, ms]) => `${galeKids.find((k) => k.id === pid)?.sku} -> ${ms.join(',')}`))

// simulate: operator selects 2 rows (product A @ market1, product B @ market2)
if (two.length >= 2) {
  const [pidA, msA] = two[0]
  const [pidB, msB] = two[1]
  const selected = [{ productId: pidA, marketplace: msA[0] }, { productId: pidB, marketplace: msB[1] ?? msB[0] }]
  const productIds = [...new Set(selected.map((s) => s.productId))]
  const markets = [...new Set(selected.map((s) => s.marketplace))]
  const actually = await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: 'AMAZON', marketplace: { in: markets }, listingStatus: { not: 'ENDED' } },
    select: { productId: true, marketplace: true, isPublished: true, product: { select: { sku: true } } },
  })
  console.log('\nSELECTED 2 rows:', selected.map((s) => `${galeKids.find((k) => k.id === s.productId)?.sku}@AMAZON:${s.marketplace}`))
  console.log('SERVER WOULD WRITE', actually.length, 'listings:', actually.map((a) => `${a.product?.sku}@${a.marketplace}${a.isPublished ? '' : '(unpublished)'}`))
}

// same for EBAY on the same group
const eb = await prisma.channelListing.findMany({
  where: { productId: { in: kidIds }, channel: 'EBAY', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, marketplace: true, product: { select: { sku: true } } },
})
const ebByPid = new Map<string, string[]>()
for (const a of eb) { const arr = ebByPid.get(a.productId) ?? []; arr.push(a.marketplace); ebByPid.set(a.productId, arr) }
console.log('\nGALE EBAY published listings:', eb.length, 'markets:', [...new Set(eb.map((e) => e.marketplace))].join(','))
const ebTwo = [...ebByPid.entries()].filter(([, ms]) => ms.length > 1).length
console.log('eBay products listed in >1 market:', ebTwo)

// --- 2) rows owned DIRECTLY by folded duplicate masters (missed when the client
//        fails to attach memberMasterIds).
const dupMasters = await prisma.product.findMany({
  where: { parentId: null, sku: { in: ['GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3', 'IT-GALE-JACKET'] } },
  select: { id: true, sku: true },
})
for (const d of dupMasters) {
  const n = await prisma.channelListing.count({ where: { productId: d.id, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } } })
  console.log(`folded master ${d.sku}: ${n} own published listing row(s)`)
}

// --- 3) grid filter (product-level) vs export filter (row-level) divergence
const products = await prisma.product.findMany({ where: { id: { in: [gale.id] } }, select: { id: true, name: true, sku: true } })
console.log('\nGALE master name:', JSON.stringify(products[0]?.name), 'sku:', products[0]?.sku)

await prisma.$disconnect()
