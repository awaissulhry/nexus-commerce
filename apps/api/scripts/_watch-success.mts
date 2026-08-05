/** READ-ONLY: one-line state for the success watcher. Prints nothing while the known 403 state persists. */
const { default: prisma } = await import('../src/db.js')
const ok = await prisma.channelPublishAttempt.count({
  where: { channel: 'AMAZON', outcome: 'success', attemptedAt: { gte: new Date(Date.now() - 15 * 60e3) } },
})
if (ok > 0) {
  console.log(`OK ${ok} successful Amazon write(s) in the last 15min`)
} else {
  const fail = await prisma.channelPublishAttempt.findFirst({
    where: { channel: 'AMAZON', outcome: 'failed', attemptedAt: { gte: new Date(Date.now() - 15 * 60e3) } },
    orderBy: { attemptedAt: 'desc' },
    select: { attemptedAt: true, errorMessage: true },
  })
  const msg = fail?.errorMessage ?? ''
  if (fail && !/403|Unauthorized|denied/i.test(msg)) {
    console.log(`NEWERR ${fail.attemptedAt.toISOString().slice(11, 19)} ${msg.slice(0, 100)}`)
  }
}
await prisma.$disconnect()
process.exit(0)
