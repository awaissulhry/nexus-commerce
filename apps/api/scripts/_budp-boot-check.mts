import '../src/env.js'
import Fastify from 'fastify'
const app = Fastify({ logger: false })
const mod = await import('../src/routes/advertising-intel.routes.js')
await app.register((mod as { default: never }).default)
await app.ready()
const routes = app.printRoutes({ commonPrefix: false })
console.log('BOOT OK — budget-rules routes registered:')
for (const l of routes.split('\n')) if (l.includes('budget-rules') || l.includes('automation-rules')) console.log('  ' + l.trim())
await app.close()
process.exit(0)
