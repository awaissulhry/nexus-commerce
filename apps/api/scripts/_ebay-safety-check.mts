/** READ-ONLY: is the eBay order poll healthy (so no orders missed without push
 *  notifications) and are zero-pushes safe pending D9 (OOS control)? */
const { default: prisma } = await import('../src/db.js')
const day = new Date(Date.now()-24*3600e3)

// 1) eBay order poll health — recent cron runs
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ebay-orders-sync' }, orderBy: { startedAt: 'desc' }, take: 5, select: { startedAt: true, status: true, outputSummary: true } })
console.log('eBay order-sync poll (newest first):')
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${r.status} ${(r.outputSummary ?? '').slice(0,90)}`)

// 2) Are we pushing qty 0 to eBay? (D9 relevance) — recent zero-qty shared fanout rows
const zeroRows = await prisma.outboundSyncQueue.findMany({
  where: { targetChannel: 'EBAY', syncType: 'QUANTITY_UPDATE', createdAt: { gte: day } },
  select: { payload: true }, take: 200,
})
let zeroUpdates = 0, totalUpdates = 0
for (const r of zeroRows) {
  const ups = (r.payload as { updates?: Array<{ quantity: number }> } | null)?.updates ?? []
  for (const u of ups) { totalUpdates++; if (u.quantity === 0) zeroUpdates++ }
}
console.log(`\neBay qty updates 24h: total=${totalUpdates}, zero-qty=${zeroUpdates}`)

// 3) Any eBay listings ENDED by a zero-push recently? (the D9 risk symptom)
const endedByZero = await prisma.sharedListingMembership.count({ where: { status: 'ENDED', lastError: { contains: 'scaduta' } } })
console.log(`memberships ended (eBay code 21916750 'scaduta'): ${endedByZero}`)

// 4) eBay notification infra: is there an amazon-style setup job / any ebay notification cron?
const ebayNotif = await prisma.cronRun.findFirst({ where: { jobName: { contains: 'ebay' } }, orderBy: { startedAt: 'desc' }, select: { jobName: true } })
console.log(`\nlatest ebay-* cron: ${ebayNotif?.jobName ?? 'none'}`)
await prisma.$disconnect()
