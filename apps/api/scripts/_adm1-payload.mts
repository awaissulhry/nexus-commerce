/** ADM.1 — fetch the REAL /advertising/campaigns payload by injecting into the real route
 *  plugin (no re-implementation, no port, RBAC shadow locally). Then measure every field. */
import '../src/env.js'
import Fastify from 'fastify'

const app = Fastify({ logger: false })
const advertisingRoutes = (await import('../src/routes/advertising.routes.js')).default
await app.register(advertisingRoutes, { prefix: '/api' })
await app.ready()

const res = await app.inject({ method: 'GET', url: '/api/advertising/campaigns?limit=500' })
console.log('HTTP', res.statusCode)
const body = res.json() as any
const rows: any[] = Array.isArray(body) ? body : (body.campaigns ?? body.data ?? body.items ?? [])
console.log('rows:', rows.length)
if (!rows.length) { console.log(JSON.stringify(body).slice(0, 600)); process.exit(0) }

const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort()
console.log(`\nfields on the payload: ${keys.length}\n`)
console.log('field'.padEnd(28), 'nonNull'.padStart(8), 'distinct'.padStart(9), '  sample')
console.log('-'.repeat(96))
for (const k of keys) {
  const vals = rows.map((r) => r[k])
  const nonNull = vals.filter((v) => v !== null && v !== undefined && v !== '').length
  const distinct = new Set(vals.map((v) => JSON.stringify(v))).size
  const sample = JSON.stringify(vals.find((v) => v !== null && v !== undefined && v !== '') ?? null)
  const flag = nonNull === 0 ? '  <-- ALWAYS EMPTY' : distinct === 1 ? '  <-- CONSTANT' : ''
  console.log(k.padEnd(28), String(nonNull).padStart(8), String(distinct).padStart(9), ' ', String(sample).slice(0, 40) + flag)
}
await app.close()
