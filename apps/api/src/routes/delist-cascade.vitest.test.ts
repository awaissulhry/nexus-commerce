import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, read: vi.fn(), claim: vi.fn(), event: vi.fn() }
})
vi.mock('../db.js', () => {
  const tx = { outboundSyncQueue: { findMany: m.read, updateMany: m.claim }, productEvent: { create: m.event } }
  return { default: { $transaction: async (run: any) => run(tx) } }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: vi.fn() }))
const { delistCascadeRoutes } = await import('./delist-cascade.routes.js')
const app = Fastify()
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', ''); delete process.env.NEXUS_RBAC_MODE
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    if (request.headers['x-user']) request.authUser = { id: String(request.headers['x-user']), roleKeys: [], permissionsVersion: 1 } as any
    request.__rbacResolved = { isOwner: false, permissions: new Set(String(request.headers['x-permission'] ?? '').split(',')) }
  })
  await app.register(delistCascadeRoutes, { prefix: '/api' }); await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => { vi.clearAllMocks(); m.read.mockResolvedValue([{ id: 'q-held', payload: { channelListingId: 'l-original', productId: 'p-original', channelConnectionId: 'owner', aliasKey: '', marketplace: 'IT', channel: 'EBAY' } }]); m.claim.mockResolvedValue({ count: 1 }) })
afterEach(() => expect(m.outbound).not.toHaveBeenCalled())
const inject = (headers: any = { 'x-user': 'operator', 'x-permission': 'products.delete' }, payload: any = { queueIds: ['q-held', 'q-too-late'] }) => app.inject({ method: 'POST', url: '/api/products/delist-cascade/cancel', headers, payload })
describe('W1.7 cancel during the five-minute window', () => {
  it.each([{}, { 'x-user': 'operator' }, { 'x-permission': 'products.delete' }, { 'x-user': 'operator', 'x-permission': 'products.edit' }])('guard rejects %j in shadow/unset mode', async headers => {
    expect((await inject(headers)).statusCode).toBe(403); expect(m.claim).not.toHaveBeenCalled()
  })
  it('positive control: products.delete cancels only eligible rows and attributes its durable event', async () => {
    const result = await inject(); expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ cancelled: ['q-held'], notCancelled: ['q-too-late'] })
    expect(m.claim).toHaveBeenCalledWith({ where: expect.objectContaining({ id: 'q-held', syncStatus: 'PENDING', retryCount: 0, createdAt: { gt: expect.any(Date) }, holdUntil: { gt: expect.any(Date) }, syncType: { in: ['UNPUBLISH_LISTING', 'DELETE_LISTING'] }, payload: { path: ['source'], equals: 'products-bulk-hard-delete' } }), data: { syncStatus: 'CANCELLED', nextRetryAt: null } })
    expect(m.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aggregateId: 'l-original', metadata: { source: 'OPERATOR', userId: 'operator' } }) }))
  })
  it('a lost CAS does not claim cancellation or emit an event', async () => {
    m.claim.mockResolvedValue({ count: 0 }); expect((await inject()).json().cancelled).toEqual([]); expect(m.event).not.toHaveBeenCalled()
  })
  it.each([{}, { queueIds: [] }, { queueIds: [null] }, { queueIds: [''] }])('malformed %j is 400', async payload => {
    expect((await inject(undefined, payload)).statusCode).toBe(400); expect(m.claim).not.toHaveBeenCalled()
  })
})
