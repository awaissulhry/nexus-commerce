/** READ-ONLY: are debounce-dead SKUs still mismatched? + readback convergence trend. */
const { default: prisma } = await import('../src/db.js')
const day = new Date(Date.now() - 24 * 3600e3)

// readback cron trend (mismatch counts per run, newest first)
const runs = await prisma.cronRun.findMany({
  where: { jobName: { contains: 'readback' } },
  orderBy: { startedAt: 'desc' },
  take: 10,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true },
})
console.log('READBACK RUNS (newest first):')
for (const r of runs) console.log(`  ${r.jobName} ${r.startedAt.toISOString()} ${r.status} ${(r.outputSummary ?? '').slice(0, 120)}`)

// the 9 debounce-dead SKUs — current queue + latest mismatch state
const dead = await prisma.outboundSyncQueue.findMany({
  where: { isDead: true, diedAt: { gte: day }, targetChannel: 'EBAY', errorMessage: { contains: 'debounced' } },
  select: { productId: true, diedAt: true, product: { select: { sku: true, id: true } } },
})
const pids = [...new Set(dead.map((d) => d.productId).filter((v): v is string => !!v))]
console.log(`\ndebounce-dead rows=${dead.length} products=${pids.length}`)

// any LIVE (non-dead) pending rows for these products now?
const pending = await prisma.outboundSyncQueue.findMany({
  where: { productId: { in: pids }, isDead: false, syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } },
  select: { productId: true, syncStatus: true, nextRetryAt: true },
})
console.log(`live pending rows for those products = ${pending.length}`)

// latest mismatch log per product (did a LATER readback cycle still flag them?)
for (const pid of pids) {
  const last = await prisma.syncHealthLog.findFirst({
    where: { conflictType: 'CHANNEL_QTY_READBACK', productId: pid },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, errorMessage: true, product: { select: { sku: true } } },
  })
  const deadAt = dead.filter((d) => d.productId === pid).map((d) => d.diedAt?.toISOString()).sort().pop()
  console.log(`  ${last?.product?.sku ?? pid}\n    lastMismatchLog=${last?.createdAt.toISOString()} lastDeadLetter=${deadAt}\n    ${(last?.errorMessage ?? '').slice(0, 130)}`)
}
await prisma.$disconnect()
