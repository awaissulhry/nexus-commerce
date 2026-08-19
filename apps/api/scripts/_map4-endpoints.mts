/** READ-ONLY exercise of the MAP.4 read endpoints against the live DB. */
await import('../src/env.js')
const Fastify = (await import('fastify')).default
const routes = (await import('../src/routes/accounts.routes.js')).default
const { default: prisma } = await import('../src/db.js')
const app = Fastify({ logger: false }); await app.register(routes, { prefix: '/api' }); await app.ready()

const conn = await prisma.channelConnection.findFirst({ where: { isActive: true, channelType: 'EBAY' }, select: { id: true } })
for (const url of ['/api/accounts', `/api/accounts/${conn!.id}/blast-radius`, '/api/accounts/does-not-exist/blast-radius']) {
  const res = await app.inject({ method: 'GET', url })
  const body = res.json() as any
  console.log(`\n${url}  ->  HTTP ${res.statusCode}`)
  if (url.endsWith('blast-radius') && body.counts) console.log('  counts:', JSON.stringify(body.counts), ' total:', body.total, ' isPrimary:', body.isPrimary)
  else if (body.accounts) console.log('  accounts:', body.accounts.map((a: any) => `${a.channel}:${a.label}${a.isPrimary ? ' (primary)' : ''}`).join(', '), '| canSwitch:', body.canSwitch)
  else console.log(' ', JSON.stringify(body))
}
await app.close(); await prisma.$disconnect()
