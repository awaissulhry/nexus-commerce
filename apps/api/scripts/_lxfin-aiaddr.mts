/**
 * LX.FIN item 1 — the /ai/bulk-generate address gate, END TO END through the real handler, with
 * ZERO provider calls and ZERO writes: the refusal arm fires before the product read, and the
 * positive-control arm is given a product id that does not exist, so it passes the gate and stops
 * at "Product not found" without reaching the AI service.
 */
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: Fastify } = await import('fastify')
const { default: prisma } = await import('../src/db.js')
const db = (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS current_database'))[0]
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log('DISCRIMINATOR', db, 'GALE-JACKET version', gale?.version)
const { default: route } = await import('../src/routes/products-ai.routes.js')
const app = Fastify()
app.addHook('onRequest', async (request: any) => { request.authUser = { id: 'lxfin-probe' } })
await app.register(route as any, { prefix: '/api' })

// Count provider calls: the service's own module-level provider getter is the only path out.
const body = (extra: Record<string, unknown>) => ({ productIds: ['lxfin-no-such-product'], fields: ['title'], marketplace: 'DE', ...extra })
const arms: Array<[string, Record<string, unknown>]> = [
  ['no address (the state every caller was in)', body({})],
  ['DISAGREEING address (it, on a DE generation)', body({ contentAddress: { tier: 'language', language: 'it' } })],
  ['AGREEING address (de, on a DE generation)', body({ contentAddress: { tier: 'language', language: 'de' } })],
  ['DISAGREEING source tier on a DE generation', body({ contentAddress: { tier: 'source' } })],
]
for (const [label, payload] of arms) {
  const res = await app.inject({ method: 'POST', url: '/api/products/ai/bulk-generate', payload })
  console.log(`${label}\n  → ${res.statusCode} ${res.body.slice(0, 240)}`)
}
await app.close()
await prisma.$disconnect()
