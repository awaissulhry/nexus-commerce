/** READ-ONLY: did a restart pick up the new token, and is Amazon accepting writes? */
const { default: prisma } = await import('../src/db.js')
const now = Date.now()
const boot = await prisma.cronRun.findFirst({ where: { jobName: 'amazon-notifications-setup' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } })
console.log(`last app BOOT marker: ${boot?.startedAt.toISOString()} (${Math.round((now - (boot?.startedAt.getTime() ?? now)) / 60e3)}m ago)`)
const att = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: { in: ['success', 'failed'] }, attemptedAt: { gte: new Date(now - 40 * 60e3) } },
  orderBy: { attemptedAt: 'desc' },
  take: 10,
  select: { attemptedAt: true, outcome: true, sku: true, errorMessage: true },
})
console.log(`real attempts last 40min: ${att.length}`)
for (const a of att) console.log(`  ${a.attemptedAt.toISOString().slice(11, 19)} ${a.outcome.padEnd(7)} ${a.sku} ${(a.errorMessage ?? '').slice(0, 70)}`)
const okCount = await prisma.channelPublishAttempt.count({ where: { channel: 'AMAZON', outcome: 'success', attemptedAt: { gte: new Date(now - 40 * 60e3) } } })
console.log(`successes last 40min: ${okCount}`)
await prisma.$disconnect()
process.exit(0)
