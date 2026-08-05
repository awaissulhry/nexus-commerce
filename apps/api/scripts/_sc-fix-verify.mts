/** READ-ONLY: post-fix convergence verification. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { getItemQuantities } = await import('../src/services/ebay-trading-api.service.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')

// 1) The previously-stuck SKUs — live eBay vs pool intent
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const CASES: Array<{ itemId: string; sku: string; expect: number; label: string }> = [
  { itemId: '257629891728', sku: 'VENTRA-JACKET-4XL-YELLOW-MEN', expect: 0, label: 'oversell (pool 0, was 5)' },
  { itemId: '257629891728', sku: 'VENTRA-JACKET-L-YELLOW-MEN', expect: 0, label: 'oversell (pool 0, was 5)' },
  { itemId: '257629891728', sku: 'VENTRA-JACKET-M-YELLOW-MEN', expect: 2, label: 'lost sales (pool 2, was 0)' },
  { itemId: '256566112769', sku: 'xavia-knee-slider-white', expect: 25, label: 'double drift (was 60)' },
  { itemId: '257608449467', sku: 'WATERPROOF-OVERJACKET-BLACK-MEN-XL', expect: 8, label: 'stamp drift (stamp said 16)' },
]
const byItem = new Map<string, typeof CASES>()
for (const c of CASES) { const a = byItem.get(c.itemId) ?? []; a.push(c); byItem.set(c.itemId, a) }
let pass = 0, fail = 0
for (const [itemId, cases] of byItem) {
  const rb = await getItemQuantities(itemId, { oauthToken: token, market: 'IT' })
  const bySku = new Map(rb.variations.map((v: { sku: string; available: number }) => [v.sku, v.available]))
  for (const c of cases) {
    const got = bySku.get(c.sku)
    const ok = got === c.expect
    ok ? pass++ : fail++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.sku}: ebay=${got} expected=${c.expect}  [${c.label}]`)
  }
  await new Promise((r) => setTimeout(r, 400))
}
// 2) Open mismatch logs + queue state
const open = await prisma.syncHealthLog.count({ where: { channel: 'EBAY', conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' } })
const pending = await prisma.outboundSyncQueue.count({ where: { targetChannel: 'EBAY', isDead: false, syncStatus: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] } } })
const newDead = await prisma.outboundSyncQueue.count({ where: { isDead: true, diedAt: { gte: new Date(Date.now() - 3 * 3600e3) }, NOT: { syncType: { startsWith: 'AD_' } } } })
console.log(`\nsummary: getitem pass=${pass} fail=${fail} · openMismatchLogs=${open} · ebayQueueOutstanding=${pending} · newNonAdsDeadLetters3h=${newDead}`)
await prisma.$disconnect()
