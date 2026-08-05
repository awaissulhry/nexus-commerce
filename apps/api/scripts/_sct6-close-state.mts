/** READ-ONLY: what did the owner's CLOSE attempt actually write? */
const { default: prisma } = await import('../src/db.js')
const closed = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', offerClosedAt: { not: null } },
  select: { marketplace: true, offerClosedAt: true, offerClosedBy: true, product: { select: { sku: true } } },
  orderBy: { offerClosedAt: 'desc' },
})
const byMkt = new Map<string, number>()
for (const c of closed) byMkt.set(c.marketplace, (byMkt.get(c.marketplace) ?? 0) + 1)
console.log(`CLOSED rows total: ${closed.length}`)
for (const [m, n] of [...byMkt.entries()].sort()) console.log(`  ${m}: ${n}`)
console.log('\nmost recent 6:')
for (const c of closed.slice(0, 6)) console.log(`  ${c.product?.sku} ${c.marketplace} at ${c.offerClosedAt?.toISOString()}`)
if (closed.length) {
  const oldest = closed[closed.length - 1].offerClosedAt!, newest = closed[0].offerClosedAt!
  console.log(`\nwindow: ${oldest.toISOString()} → ${newest.toISOString()} (${((+newest - +oldest) / 1000).toFixed(0)}s)`)
}
// audit: how many close audits landed
const audit = await prisma.syncControlAudit.count({ where: { field: 'offerClosed', createdAt: { gte: new Date(Date.now() - 2 * 3600e3) } } })
console.log(`offerClosed audit rows last 2h: ${audit}`)
await prisma.$disconnect()
