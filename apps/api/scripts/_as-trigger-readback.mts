/** Operational: insert the amazon-qty-readback boot directive (consumed at next deploy/restart). */
const { default: prisma } = await import('../src/db.js')
const row = await prisma.cronRun.create({
  data: { jobName: 'amazon-qty-readback-request', status: 'RUNNING', triggeredBy: 'manual' },
})
console.log('directive inserted:', row.id)
await prisma.$disconnect()
process.exit(0)
