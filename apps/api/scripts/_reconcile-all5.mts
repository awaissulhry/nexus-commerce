process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const itemId of ['257584954808', '256564203510', '256566101420', '256566102729', '256566103703']) {
  const r = await app.inject({ method: 'POST', url: '/ebay/flat-file/reconcile-item', payload: { itemId, marketplace: 'IT' } })
  const d = r.json() as any
  console.log(d.error ? `${itemId}: ERROR ${d.error}` : `${itemId}: live=${d.liveVariations} matched=${d.matched} staleRemoved=${d.removedStale}`)
}
const { default: prisma } = await import('../src/db.js')
const m = await prisma.sharedListingMembership.groupBy({ by: ['itemId'], where: { marketplace: 'IT' }, _count: true })
console.log('final memberships per listing:', JSON.stringify(m.map((x: any) => `${x.itemId}:${x._count}`)))
await prisma.$disconnect(); await app.close(); process.exit(0)
