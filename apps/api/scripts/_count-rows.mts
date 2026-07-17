const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const scope of ['listed', 'all']) {
  const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?scope=${scope}&marketplace=IT` })
  const rows = (r.json() as any).rows ?? []
  const shared = rows.filter((x: any) => x._shared === true).length
  const parents = rows.filter((x: any) => x._isParent === true).length
  const galeShared = rows.filter((x: any) => x._shared === true && String(x.parent_sku ?? '').includes('GALE')).length
  console.log(`scope=${scope}: total=${rows.length} parents=${parents} _shared=${shared} (gale ${galeShared}) real-children=${rows.length - parents - shared}`)
}
const { default: prisma } = await import('../src/db.js')
const jobs = await prisma.ebayPushJob.findMany({ orderBy: { submittedAt: 'desc' }, take: 4, select: { mode: true, status: true, skuCount: true, submittedAt: true } })
console.log('recent pushes:', JSON.stringify(jobs.map(j => ({ ...j, submittedAt: j.submittedAt.toISOString().slice(11, 19) }))))
await prisma.$disconnect()
await app.close()
process.exit(0)
