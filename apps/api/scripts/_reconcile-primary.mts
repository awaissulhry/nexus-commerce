process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
const r = await app.inject({ method: 'POST', url: '/ebay/flat-file/reconcile-item', payload: { itemId: '257584954808', marketplace: 'IT' } })
const d = r.json() as any
console.log(`primary: live=${d.liveVariations} matched=${d.matched} rewired=${d.rewritten} staleRemoved=${d.removedStale}${d.unmatched?.length ? ` unmatched=[${d.unmatched.join(', ')}]` : ''}`)
const { default: prisma } = await import('../src/db.js')
const del = await prisma.outboundSyncQueue.deleteMany({
  where: { targetChannel: 'EBAY', syncStatus: 'FAILED', payload: { path: ['pushVia'], equals: 'TRADING' } },
})
console.log(`cleared dead entries: ${del.count}`)
const state = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { targetChannel: 'EBAY', payload: { path: ['pushVia'], equals: 'TRADING' } }, _count: true })
console.log('final queue:', JSON.stringify(state))
await prisma.$disconnect()
await app.close()
process.exit(0)
