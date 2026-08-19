/** READ-ONLY verification: registers ONLY accounts.routes on a bare Fastify
 *  instance and injects two GETs. No port bound, no crons, no other routes. */
await import('../src/env.js')
const Fastify = (await import('fastify')).default
const accountsRoutes = (await import('../src/routes/accounts.routes.js')).default

const app = Fastify({ logger: false })
await app.register(accountsRoutes, { prefix: '/api' })
await app.ready()

for (const url of ['/api/accounts', '/api/accounts/diagnostics']) {
  const res = await app.inject({ method: 'GET', url })
  console.log(`\n──── ${url}  →  HTTP ${res.statusCode}`)
  console.log(JSON.stringify(res.json(), null, 2))
}
await app.close()
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
