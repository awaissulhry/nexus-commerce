/** RT.3 — insert the one-shot notification-pipe RECYCLE directive (consumed at next boot). */
const { default: prisma } = await import('../src/db.js')
const existing = await prisma.cronRun.findFirst({
  where: { jobName: 'amazon-notifications-recycle-request', status: 'RUNNING' },
})
if (existing) {
  console.log(`request already pending: ${existing.id} (${existing.startedAt.toISOString()})`)
} else {
  const row = await prisma.cronRun.create({
    data: {
      jobName: 'amazon-notifications-recycle-request',
      status: 'RUNNING',
      outputSummary: 'requested by RT.3 session 2026-07-20 — defunct destination, zero deliveries ever',
    },
    select: { id: true },
  })
  console.log(`recycle request inserted: ${row.id}`)
}
await prisma.$disconnect()
process.exit(0)
