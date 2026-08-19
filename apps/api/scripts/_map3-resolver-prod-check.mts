/** READ-ONLY. Exercises every resolver scope form against the real database. */
const { default: prisma } = await import('../src/db.js')
const R = await import('../src/services/connection-resolver.service.js')

const show = async (label: string, fn: () => Promise<any>) => {
  try { const c = await fn(); console.log(`  ${label.padEnd(46)} -> ${c.channelType} ${c.id}`) }
  catch (e: any) { console.log(`  ${label.padEnd(46)} -> ${e.name}: ${String(e.message).slice(0,90)}`) }
}

const listing = await prisma.channelListing.findFirst({ where: { channel: 'EBAY' }, select: { id: true } })
const amzListing = await prisma.channelListing.findFirst({ where: { channel: 'AMAZON' }, select: { id: true } })
const member = await prisma.sharedListingMembership.findFirst({ select: { itemId: true, marketplace: true } })
const order = await prisma.order.findFirst({ where: { channel: 'EBAY' }, select: { id: true, channelOrderId: true } })
const amzOrder = await prisma.order.findFirst({ where: { channel: 'AMAZON' }, select: { id: true } })
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })

console.log('DERIVED scopes (read the attribution MAP.2a backfilled)')
await show(`{ listingId } eBay`,        () => R.resolveConnection({ listingId: listing!.id }))
await show(`{ listingId } Amazon`,      () => R.resolveConnection({ listingId: amzListing!.id }))
await show(`{ itemId: ${member!.itemId} }`, () => R.resolveConnection({ itemId: member!.itemId }))
await show(`{ orderId } eBay`,          () => R.resolveConnection({ orderId: order!.id }))
await show(`{ orderId } Amazon`,        () => R.resolveConnection({ orderId: amzOrder!.id }))
await show(`{ channel, channelOrderId }`, () => R.resolveConnection({ channel: 'EBAY', channelOrderId: order!.channelOrderId }))

console.log('\nNAMED and DECLARED scopes')
await show(`{ accountId }`,             () => R.resolveConnection({ accountId: conn!.id }))
await show(`{ channel: EBAY, primary }`, () => R.resolveConnection({ channel: 'EBAY', primary: true }))
await show(`{ channel: AMAZON, primary }`, () => R.resolveConnection({ channel: 'AMAZON', primary: true }))

console.log('\nREFUSALS (these must throw, not guess)')
await show(`{ channel: SHOPIFY, primary } (none active)`, () => R.resolveConnection({ channel: 'SHOPIFY', primary: true }))
await show(`{ listingId: 'nope' }`,     () => R.resolveConnection({ listingId: 'nope' }))
await show(`{ accountId: <revoked> }`,  async () => {
  const dead = await prisma.channelConnection.findFirst({ where: { isActive: false }, select: { id: true } })
  return R.resolveConnection({ accountId: dead!.id })
})

console.log('\nlistActiveConnections')
for (const ch of ['EBAY', 'AMAZON', 'SHOPIFY']) {
  const rows = await R.listActiveConnections(ch)
  console.log(`  ${ch.padEnd(8)} ${rows.length} active${rows.length ? ` (primary=${rows.filter(r=>r.isPrimary).length})` : ''}`)
}
await prisma.$disconnect()
