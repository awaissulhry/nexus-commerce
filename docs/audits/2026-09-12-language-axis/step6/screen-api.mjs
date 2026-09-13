/** Actual route handlers on a fixed, read-only local catalogue; provider transport is blocked before import. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import Fastify from 'fastify'
import { databaseTarget } from '../step1/target.mjs'
const target = await databaseTarget('local'); assert.equal(target.identity.database, 'nexus_development')
const url = new URL(target.connectionString); url.searchParams.set('options', '-c default_transaction_read_only=on')
Object.assign(process.env, { DATABASE_URL: url.toString(), NEXUS_WORKSPACES_ENABLED: '0', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: 'false' })
const transportAttempts = [], requests = []; globalThis.__lxBlockedGateways = []
const deny = () => { transportAttempts.push(new Date().toISOString()); throw new Error('Step 6 screen forbids provider transport.') }
https.request = deny; https.get = deny; http.request = deny; http.get = deny; globalThis.fetch = deny; syncBuiltinESMExports()
const runtime = await import('./rehearsal-runtime-screen.mjs')
const { prisma, inDatabaseTransaction, withCachedSchemas } = runtime
const rootId = 'cmokmy3a40078pm0p1fvnu523'
const family = await prisma.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }] }, select: { id: true, sku: true } })
assert.equal(family.find(p => p.id === rootId)?.sku, 'GALE-JACKET')
const app = Fastify({ logger: false })
const allowed = path => path === '/api/marketplaces/grouped' || path === '/api/connections' || path === '/api/saved-views' || path === `/api/pim/family/${rootId}` || path === '/api/categories/reference-labels' ||
 path === `/api/products/${rootId}` || path.startsWith(`/api/products/${rootId}/studio/`) || path === `/api/products/${rootId}/readiness` ||
 path === `/api/products/${rootId}/sync-queue` || path === `/api/products/${rootId}/global` ||
 path.startsWith('/api/pim/formulas/') || /^\/api\/products\/ai\/drafts/.test(path)
app.addHook('onRequest', async (request, reply) => {
 request.authUser = { id: 'lx4_gate_da778dba-6b1b-4912-a05b-dad2ba810e47' }
 const path = request.url.split('?')[0]
 if (path.startsWith('/gate/')) return
 if (!allowed(path) || request.method !== 'GET' && !(request.method === 'POST' && path === '/api/pim/formulas/batch'))
  return reply.code(403).send({ error: 'Outside the GALE-JACKET read-only screen gate.' })
})
app.addHook('onRoute', route => {
 const handler = route.handler
 route.handler = async function(request, reply) {
  const sentinel = new Error('Read-only screen rollback'); let result
  try { await inDatabaseTransaction(prisma, () => withCachedSchemas(async () => {
   result = await handler.call(this, request, reply); throw sentinel
  })) } catch (error) { if (error !== sentinel) throw error }
  requests.push({ at: new Date().toISOString(), method: request.method, path: request.url, status: reply.statusCode, rolledBack: true })
  return result
 }
})
for (const name of ['products', 'productsAi', 'savedViews', 'pim', 'categories', 'studio', 'formulas', 'global', 'marketplaces', 'connections']) await app.register(runtime[name], { prefix: '/api' })
app.get('/gate/evidence', async () => ({ at: new Date().toISOString(), target: target.identity, family, transportAttempts, blockedGateways: globalThis.__lxBlockedGateways, requests }))
await app.listen({ host: '127.0.0.1', port: 4120 })
console.log(JSON.stringify({ ready: true, port: 4120, target: target.identity, familyRows: family.length, readOnly: true }))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
 fs.writeFileSync(new URL('screen-api-evidence.json', import.meta.url), JSON.stringify({ transportAttempts, blockedGateways: globalThis.__lxBlockedGateways, requests }, null, 2) + '\n')
 await app.close(); await prisma.$disconnect(); process.exit(0)
})
