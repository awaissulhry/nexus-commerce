import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const [en, pa] = await Promise.all([
  prisma.campaign.count({ where: { status: 'ENABLED' } }),
  prisma.campaign.count({ where: { status: 'PAUSED' } }),
])
console.log(`ENABLED=${en} PAUSED=${pa}`)
const recent = await prisma.campaign.findMany({ where: { status: 'PAUSED', updatedAt: { gte: new Date(Date.now() - 90*60e3) } }, select: { name: true, marketplace: true, updatedAt: true, dailyBudget: true }, orderBy: { updatedAt: 'desc' }, take: 30 })
console.log(`\nPAUSED with updatedAt in the last 90 min: ${recent.length}`)
for (const c of recent) console.log(`  ${c.updatedAt.toISOString()} ${c.marketplace} ${c.name} (EUR${c.dailyBudget})`)
const logs = await prisma.advertisingActionLog.count({ where: { actionType: { contains: 'PAUSE' }, createdAt: { gte: new Date(Date.now() - 90*60e3) } } })
console.log(`\nour own PAUSE action-log rows in that window: ${logs}`)
await prisma.$disconnect()
