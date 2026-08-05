/** READ-ONLY: full queue trail for VENTRA-JACKET-4XL-YELLOW-MEN since 20:00Z. */
const { default: prisma } = await import('../src/db.js')
const p = await prisma.product.findFirst({ where: { sku: 'VENTRA-JACKET-4XL-YELLOW-MEN' }, select: { id: true } })
const rows = await prisma.outboundSyncQueue.findMany({
  where: { productId: p!.id, targetChannel: 'EBAY', updatedAt: { gte: new Date('2026-07-20T20:00:00Z') } },
  orderBy: { updatedAt: 'asc' },
  select: { id: true, syncStatus: true, errorCode: true, errorMessage: true, retryCount: true, isDead: true, nextRetryAt: true, createdAt: true, updatedAt: true, holdUntil: true, payload: true },
})
console.log('rows=' + rows.length)
for (const r of rows) {
  const pl = r.payload as { itemId?: string; updates?: Array<{ sku: string; quantity: number; oldQuantity?: number | null }> } | null
  console.log(`${r.createdAt.toISOString()} → ${r.updatedAt.toISOString()} ${r.syncStatus}${r.isDead ? '/DEAD' : ''} rc=${r.retryCount} code=${r.errorCode ?? '-'} hold=${r.holdUntil?.toISOString() ?? '-'} next=${r.nextRetryAt?.toISOString() ?? '-'}`)
  console.log(`   item=${pl?.itemId} updates=${JSON.stringify(pl?.updates ?? []).slice(0, 140)}`)
  if (r.errorMessage) console.log(`   err=${r.errorMessage.slice(0, 120)}`)
}
const mem = await prisma.sharedListingMembership.findMany({
  where: { productId: p!.id },
  select: { itemId: true, status: true, lastQtyPushed: true, lastPushedAt: true, lastError: true },
})
for (const m of mem) console.log(`MEM ${m.itemId} ${m.status} lastPushed=${m.lastQtyPushed} at=${m.lastPushedAt?.toISOString()}\n   ${(m.lastError ?? '').slice(0, 130)}`)
await prisma.$disconnect()
