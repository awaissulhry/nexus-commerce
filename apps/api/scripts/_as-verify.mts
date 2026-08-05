/** READ-ONLY: AS-series prod verification snapshot. */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const H = 3600e3

// 1) AS.3 — eBay orders poll green?
const eo = await prisma.cronRun.findMany({
  where: { jobName: 'ebay-orders-sync' },
  orderBy: { startedAt: 'desc' },
  take: 6,
  select: { startedAt: true, status: true, outputSummary: true },
})
console.log('== ebay-orders-sync recent ==')
for (const r of eo) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${r.status} ${(r.outputSummary ?? '').slice(0, 150)}`)

// 2) AS.1 — AUTH_REQUIRED rows emerging? errorCode distribution of open AMAZON rows
const codes = await prisma.outboundSyncQueue.groupBy({
  by: ['errorCode'],
  where: { targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', syncStatus: 'FAILED', isDead: false },
  _count: true,
})
console.log('== AMAZON parked FAILED rows by errorCode ==', codes.map((c) => `${c.errorCode ?? '-'}=${c._count}`).join(' '))
const dead24 = await prisma.outboundSyncQueue.count({
  where: { targetChannel: 'AMAZON', isDead: true, diedAt: { gte: new Date(now - 2 * H) } },
})
console.log(`   newly dead-lettered last 2h: ${dead24}`)

// 3) AS.1 — watchdog tripwires + CHANNEL_AUTH_FAILURE rows
const wd = await prisma.cronRun.findMany({
  where: { jobName: 'latency-watchdog' },
  orderBy: { startedAt: 'desc' },
  take: 3,
  select: { startedAt: true, status: true, outputSummary: true },
})
console.log('== latency-watchdog recent ==')
for (const r of wd) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${r.status} ${(r.outputSummary ?? '').slice(0, 120)}`)
const auth = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_AUTH_FAILURE' },
  orderBy: { createdAt: 'desc' },
  take: 3,
  select: { createdAt: true, channel: true, errorMessage: true },
})
console.log('== CHANNEL_AUTH_FAILURE rows ==', auth.length ? '' : '(none yet)')
for (const a of auth) console.log(`  ${a.createdAt.toISOString().slice(11, 19)} ${a.channel} ${(a.errorMessage ?? '').slice(0, 120)}`)

// 4) AS.1 — flip-guard behavior post-deploy
const fg = await prisma.cronRun.findMany({
  where: { jobName: 'fba-flip-guard' },
  orderBy: { startedAt: 'desc' },
  take: 3,
  select: { startedAt: true, outputSummary: true },
})
console.log('== fba-flip-guard recent ==')
for (const r of fg) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${(r.outputSummary ?? '').slice(0, 120)}`)

// 5) AS.4a — ebay-readback combined summary (post-AS.4 deploy)
const rb = await prisma.cronRun.findMany({
  where: { jobName: 'ebay-readback' },
  orderBy: { startedAt: 'desc' },
  take: 3,
  select: { startedAt: true, status: true, outputSummary: true },
})
console.log('== ebay-readback recent ==')
for (const r of rb) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${r.status} ${(r.outputSummary ?? '').slice(0, 170)}`)

// 6) recent AMAZON attempts (auth state unchanged? successes resumed?)
const att = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: { in: ['success', 'failed'] }, attemptedAt: { gte: new Date(now - 2 * H) } },
  orderBy: { attemptedAt: 'desc' },
  take: 6,
  select: { attemptedAt: true, outcome: true, sku: true, errorMessage: true },
})
console.log('== AMAZON real attempts last 2h ==')
for (const a of att) console.log(`  ${a.attemptedAt.toISOString().slice(11, 19)} ${a.outcome.padEnd(7)} ${a.sku} ${(a.errorMessage ?? '').slice(0, 90)}`)

await prisma.$disconnect()
process.exit(0)
