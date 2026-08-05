const { default: prisma } = await import('../src/db.js')

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  const r = await fn()
  console.log(`  ${label}: ${Date.now() - t}ms`)
  return r
}

for (let round = 1; round <= 3; round++) {
  console.log(`--- round ${round} ---`)
  const tAll = Date.now()
  const [listings, memberships] = await timed('base queries', async () =>
    Promise.all([
      prisma.channelListing.findMany({
        where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
        select: {
          productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
          followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
          product: { select: { sku: true, fulfillmentMethod: true } },
        },
      }),
      prisma.sharedListingMembership.findMany({
        where: { status: 'ACTIVE' },
        select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
      }),
    ]),
  )
  const productIds = [...new Set([...listings.map((l) => l.productId), ...memberships.map((m) => m.productId).filter(Boolean) as string[]])]
  await timed('buildLedgers', async () =>
    prisma.stockLevel.findMany({
      where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
      select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
    }),
  )
  const rowPids = productIds
  const rowProducts = await timed('rowProducts', async () =>
    prisma.product.findMany({ where: { id: { in: rowPids } }, select: { id: true, parentId: true } }),
  )
  const masterOf = new Map(rowProducts.map((p) => [p.id, p.parentId ?? p.id]))
  const masterIds = [...new Set(rowPids.map((id) => masterOf.get(id) ?? id))]
  await timed('resolveCanonical(q1+q2)', async () =>
    Promise.all([
      prisma.product.findMany({ where: { parentId: { in: masterIds } }, select: { parentId: true }, distinct: ['parentId'] }),
      prisma.product.findMany({ where: { id: { in: masterIds } }, select: { id: true, sku: true } }),
    ]),
  )
  console.log(`  TOTAL ~${Date.now() - tAll}ms | listings=${listings.length} mems=${memberships.length} rows=${listings.length + memberships.length} pids=${productIds.length} masters=${masterIds.length}`)
}
await prisma.$disconnect()
