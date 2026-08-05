const { default: prisma } = await import('../src/db.js')
const since = new Date(Date.now() - 24 * 3600 * 1000)
const ms = await prisma.adSchedule.findMany({ where: { groupId: { not: null } }, select: { id: true, groupId: true } })
const actors = ms.map((m) => `automation:rank-defend-${m.id}`)
const [q, i] = await Promise.all([
  prisma.adMutation.count({ where: { state: 'FAILED', actor: { in: actors }, updatedAt: { gte: since } } }),
  prisma.advertisingActionLog.count({ where: { amazonResponseStatus: 'FAILED', userId: { in: actors }, createdAt: { gte: since } } }),
])
console.log(`badge counts right now → queued=${q} inline=${i} total=${q + i}`)
const newest = await prisma.advertisingActionLog.findFirst({ where: { amazonResponseStatus: 'FAILED', userId: { in: actors } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
if (newest) {
  const clears = new Date(newest.createdAt.getTime() + 24 * 3600 * 1000)
  console.log(`newest counted failure: ${newest.createdAt.toISOString()}`)
  console.log(`badge goes green at:    ${clears.toISOString()}  (in ${Math.round((clears.getTime() - Date.now()) / 60000)} min)`)
}
await prisma.$disconnect()
