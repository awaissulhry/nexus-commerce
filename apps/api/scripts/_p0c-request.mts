const { default: prisma } = await import('../src/db.js')
const existing = await prisma.cronRun.findFirst({ where: { jobName: 'amazon-qty-readback-request', status: 'RUNNING' } })
if (existing) console.log(`already pending: ${existing.id}`)
else {
  const r = await prisma.cronRun.create({ data: { jobName: 'amazon-qty-readback-request', status: 'RUNNING', outputSummary: 'first read-back on deploy (P0c, 2026-07-20)' }, select: { id: true } })
  console.log(`readback request inserted: ${r.id}`)
}
await prisma.$disconnect(); process.exit(0)
