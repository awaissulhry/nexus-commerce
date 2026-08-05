/** READ-ONLY: probe 5 — FBM order ingest lag detail + reconcile-suite CronRun over 14d. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const d14 = new Date(now - 14 * 24 * 3600e3)

const fbm = await prisma.order.findMany({
  where: { channel: 'AMAZON', fulfillmentMethod: 'FBM', createdAt: { gte: d14 } },
  select: { channelOrderId: true, marketplace: true, purchaseDate: true, createdAt: true, status: true },
  orderBy: { createdAt: 'desc' },
  take: 20,
})
console.log('== FBM Amazon orders last 14d (ingest lag) ==')
for (const o of fbm) {
  const lagMin = o.purchaseDate ? Math.round((o.createdAt.getTime() - o.purchaseDate.getTime()) / 60e3) : null
  console.log(`  ${o.channelOrderId} ${o.marketplace} ${o.status} purchase=${o.purchaseDate?.toISOString()} ingest=+${lagMin}min`)
}

const suite = ['inventory-reconcile', 'reconcile-cron', 'latency-watchdog', 'ebay-readback', 'reservation-reconcile', 'sync-drift-detection', 'fba-drift-detector', 'ebay-status-reconcile', 'ebay-label-guard']
const runs = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { startedAt: { gte: d14 }, jobName: { in: suite } },
  _count: { _all: true },
  _max: { startedAt: true },
})
console.log('== Reconcile-suite CronRun last 14d ==')
if (!runs.length) console.log('  (none recorded)')
for (const r of runs) console.log(`  ${r.jobName}: runs=${r._count._all} last=${r._max.startedAt?.toISOString()}`)

await prisma.$disconnect()
process.exit(0)
