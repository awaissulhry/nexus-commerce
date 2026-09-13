import { expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdir, writeFile } from 'node:fs/promises'
const state = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('No channel call is allowed in an impact read') })
  vi.stubGlobal('fetch', fetch)
  vi.stubEnv('NEXUS_DISABLE_BACKGROUND_JOBS', '1')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '0')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
  return { fetch }
})
vi.mock('../../lib/queue.js', () => ({ redis: { connection: null }, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, addJobSafely: vi.fn() }))
vi.mock('../content-auto-publish.service.js', () => ({ enqueueContentSyncForProduct: vi.fn(), enqueueContentSyncIfEnabled: vi.fn() }))

it.skipIf(process.env.PR1_LOCAL_IMPACT !== '1')('LOCAL Docker: GALE operational impact through actual Fastify routes, no writes', async () => {
  const target = new URL(process.env.DATABASE_URL!)
  expect(target.host).toBe('127.0.0.1:55439')
  expect(target.pathname).toBe('/nexus_development')
  console.log(`PR.1 IMPACT DATABASE ${target.host}${target.pathname}; read only`)
  const [{ default: prisma }, { default: catalog }] = await Promise.all([import('../../db.js'), import('../../routes/products-catalog.routes.js')])
  const id = 'cmokmy3a40078pm0p1fvnu523'
  const before = await prisma.product.findUniqueOrThrow({ where: { id }, select: { id: true, sku: true, version: true, updatedAt: true } })
  const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: id, channel: 'EBAY', marketplace: 'IT' }, select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
  const app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    request.authUser = { id: 'pr1-local-read', roleKeys: [], permissionsVersion: 1 } as any
    request.__rbacResolved = { isOwner: false, permissions: new Set(['products.view']) }
  })
  await app.register(catalog, { prefix: '/api' }); await app.ready()
  const receipts = []
  try {
    for (const options of [
      { method: 'GET' as const, url: `/api/products/hard-delete-preflight?ids=${id}` },
      { method: 'POST' as const, url: '/api/products/operational-impact', payload: { verb: 'hold', targets: [listing] } },
      { method: 'POST' as const, url: '/api/products/operational-impact', payload: { verb: 'hard-delete', targets: [{ productId: id }] } },
    ]) {
      const started = performance.now()
      const response = await app.inject(options)
      const elapsedMs = performance.now() - started
      expect(response.statusCode, response.body).toBe(200)
      receipts.push({ method: options.method, url: options.url, elapsedMs, statusCode: response.statusCode, body: response.json() })
    }
    expect(receipts[0].body.confirmPhrase).toBe('GALE-JACKET')
    expect(receipts[1].body.targets[0].target).toEqual(listing)
    expect(receipts[1].body.targets[0].checks.openOrders.status).toBe('ok')
    expect(receipts[2].body.targets[0].checks.stockHolds.blocking).toBe(false)
    expect(receipts[2].body.targets[0].checks.advertising.blocking).toBe(false)
    expect(state.fetch).not.toHaveBeenCalled()
    expect(await prisma.product.findUniqueOrThrow({ where: { id }, select: { id: true, sku: true, version: true, updatedAt: true } })).toEqual(before)
    await mkdir('../../docs/audits/2026-09-13-presence/pr1', { recursive: true })
    await writeFile('../../docs/audits/2026-09-13-presence/pr1/operational-impact-local.json', JSON.stringify({ database: `${target.host}${target.pathname}`, at: new Date().toISOString(), product: before, receipts }, null, 2))
    console.log(JSON.stringify(receipts.map(({ method, url, statusCode, elapsedMs }) => ({ method, url, statusCode, elapsedMs }))))
  } finally { await app.close(); await prisma.$disconnect() }
}, 30_000)
