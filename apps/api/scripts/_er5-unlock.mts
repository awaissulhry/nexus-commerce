const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const rows = await prisma.$queryRawUnsafe<Array<{ pid: number; state: string | null }>>(
  `SELECT l.pid, a.state FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype='advisory' AND l.objid=72707369`)
console.log('HOLDERS:', JSON.stringify(rows))
for (const r of rows) {
  await prisma.$executeRawUnsafe(`SELECT pg_terminate_backend(${Number(r.pid)})`)
  console.log('terminated pid', r.pid)
}
process.exit(0)
