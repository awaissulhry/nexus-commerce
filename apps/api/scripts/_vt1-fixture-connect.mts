/** VT.1 — point the VX-TEST-3AX listings at the SAME account GALE's listings use, so the studio resolves them. LOCAL only. */
const url = process.argv[2]
if (!url || url.includes('neon.tech')) { console.error('local URL required'); process.exit(2) }
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true } })
console.log('discriminator GALE version:', gale!.version)
for (const [channel, marketplace] of [['AMAZON','IT'],['SHOPIFY','GLOBAL']] as const) {
  const src = await p.channelListing.findFirst({ where: { productId: gale!.id, channel, marketplace }, select: { channelConnectionId: true } })
  const n = await p.channelListing.updateMany({
    where: { channel, marketplace, product: { OR: [{ sku: 'VX-TEST-3AX' }, { sku: { startsWith: 'VX-TEST-3AX-' } }] } },
    data: { channelConnectionId: src?.channelConnectionId ?? null },
  })
  console.log(`${channel}/${marketplace}: connection ${src?.channelConnectionId ?? 'null'} set on ${n.count} rows`)
}
const back = await p.channelListing.findMany({ where: { product: { sku: 'VX-TEST-3AX' } }, select: { channel: true, marketplace: true, channelConnectionId: true, version: true, listingStatus: true, externalListingId: true } })
console.log('read back (parent rows):', JSON.stringify(back))
await p.$disconnect()
