import prisma from '../src/db.js'
const now = await prisma.$queryRaw`SELECT now()` as any
console.log('DB now:', now[0].now)
const runs = await prisma.cronRun.findMany({ where: { job: { contains: 'review' } }, orderBy: { createdAt: 'desc' }, take: 5, select: { job: true, status: true, createdAt: true, error: true } }).catch(() => null)
console.log('cron runs:', JSON.stringify(runs, null, 1)?.slice(0, 600))
const rr = await prisma.reviewRequest.groupBy({ by: ['status'], _count: true }).catch((e) => 'no ReviewRequest table: ' + e.message.slice(0, 80))
console.log('ReviewRequest by status:', JSON.stringify(rr))
const recent = await prisma.reviewRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { status: true, createdAt: true, scheduledFor: true, skipReason: true } }).catch(() => [])
console.log('recent:', JSON.stringify(recent, null, 1))
const orders = await prisma.order.count({ where: { deliveredAt: { gte: new Date(Date.now() - 14 * 86400000) } } }).catch(async () => {
  const alt = await prisma.order.count({ where: { createdAt: { gte: new Date(Date.now() - 14 * 86400000) } } })
  return `no deliveredAt — created 14d: ${alt}`
})
console.log('orders delivered/created 14d:', orders)
process.exit(0)
