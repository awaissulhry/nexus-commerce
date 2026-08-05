/** READ-ONLY: fetch the stored getOrders response to see the real order shape. */
const { default: prisma } = await import('../src/db.js')
const call = await prisma.outboundApiCallLog.findFirst({
  where: { channel: 'EBAY', operation: 'getOrders', success: true },
  orderBy: { createdAt: 'desc' },
  select: { createdAt: true, responsePayload: true },
})
if (!call) {
  console.log('no stored getOrders call')
  process.exit(0)
}
console.log('call at', call.createdAt.toISOString())
const body = call.responsePayload as { orders?: unknown[] } | null
const first = body?.orders?.[0] as Record<string, unknown> | undefined
if (!first) {
  console.log('no orders in stored payload:', JSON.stringify(body)?.slice(0, 300))
  process.exit(0)
}
console.log('order keys:', Object.keys(first).join(', '))
console.log(JSON.stringify(first, null, 1).slice(0, 2600))
await prisma.$disconnect()
process.exit(0)
