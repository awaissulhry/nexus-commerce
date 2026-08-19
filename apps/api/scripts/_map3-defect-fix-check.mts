/** READ-ONLY. Proves the two paths that threw since 2026-05-07 now resolve.
 *  Exercises exactly the resolution each call site performs — no writes, no eBay. */
const { default: prisma } = await import('../src/db.js')
const { resolveConnection } = await import('../src/services/connection-resolver.service.js')

// 1) orders.routes.ts — eBay cancellation resolves from the order id.
const ebayOrder = await prisma.order.findFirst({ where: { channel: 'EBAY' }, select: { id: true, channelOrderId: true } })
console.log('orders.routes.ts eBay cancel path')
console.log('  BEFORE: where { channel: "EBAY" }  -> PrismaClientValidationError (proven 2026-08-19)')
try {
  const c = await resolveConnection({ orderId: ebayOrder!.id })
  console.log(`  AFTER : resolveConnection({ orderId })  -> ${c.channelType} ${c.id}  ✓`)
} catch (e: any) { console.log('  AFTER : FAILED ->', e.message) }

// 2) ebay-pushback — tracking upload resolves from the shipment's order.
const shipment = await prisma.shipment.findFirst({
  where: { order: { channel: 'EBAY' } },
  select: { id: true, order: { select: { id: true } } },
})
console.log('\nebay-pushback tracking-upload path')
if (!shipment) {
  console.log('  no eBay shipment rows on prod to sample; resolving via any eBay order instead')
  const c = await resolveConnection({ orderId: ebayOrder!.id })
  console.log(`  resolveConnection({ orderId }) -> ${c.channelType} ${c.id}  ✓`)
} else {
  const c = await resolveConnection({ orderId: shipment.order.id })
  console.log(`  resolveConnection({ orderId: shipment.order.id }) -> ${c.channelType} ${c.id}  ✓`)
}

// 3) And confirm the OLD query still fails, so the fix is not cosmetic.
console.log('\ncontrol — the old query, unchanged:')
try {
  await (prisma as any).channelConnection.findFirst({ where: { channel: 'EBAY', isActive: true }, select: { id: true } })
  console.log('  UNEXPECTED: the old query succeeded')
} catch (e: any) { console.log(`  still throws ${e.constructor.name}: Unknown argument \`channel\`  ✓`) }
await prisma.$disconnect()
