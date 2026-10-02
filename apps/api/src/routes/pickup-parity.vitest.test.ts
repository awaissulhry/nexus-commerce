/**
 * MCP full control 07 O17 — carrier pickups (POST /fulfillment/carriers/:code/pickups and …/:id/cancel) move into
 * services/fulfillment/pickup.service.ts with NO change to what the routes do and answer. The snapshots in
 * __snapshots__/pickup-parity.vitest.test.ts.snap were written by the route code BEFORE the move: a carrier not
 * connected, the two refusals, a one-time and a recurring MANUAL pickup (recorded only), a one-time Sendcloud pickup
 * (from the warehouse's sender, from the default sender, refused by Sendcloud), a cancel — with the rows they leave.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin; Sendcloud is mocked. Ids and times masked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
const carrier = vi.hoisted(() => ({ pickups: [] as unknown[], refuse: false }))
vi.mock('../services/sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  listSenderAddresses: vi.fn(async () => [{ id: 11, isDefault: false }, { id: 12, isDefault: true }]),
  requestPickup: vi.fn(async (_creds: unknown, input: Record<string, unknown>) => {
    carrier.pickups.push(input)
    return carrier.refuse ? { ok: false, reason: 'Test: no pickup that day' } : { ok: true, externalRef: `TEST-PU-${carrier.pickups.length}`, scheduledFor: input.pickupDate, status: 'Scheduled' }
  }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const MADE = new Set(['id', 'createdAt', 'updatedAt', 'workspaceId', 'lastDispatchAt'])
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (MADE.has(key) && v !== null ? '<made>' : v)))

describe('07 O17 — pickups: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const post = async (url: string, payload: unknown = {}) => {
    const response = await app.inject({ method: 'POST', url: `/api${url}`, payload: payload as object })
    return { status: response.statusCode, body: stable(JSON.parse(response.body || '{}')) }
  }
  let firstId = ''

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      await database.client.carrier.create({ data: { id: 'test-carrier-sc', code: 'SENDCLOUD', name: 'Sendcloud', isActive: true } as never })
      await database.client.carrier.create({ data: { id: 'test-carrier-manual', code: 'MANUAL', name: 'Manual', isActive: true } as never })
      await database.client.warehouse.create({ data: { id: 'test-wh', code: 'TEST-WH', name: 'Test warehouse', isDefault: true, sendcloudSenderId: 77, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('refusals; MANUAL one-time and recurring; Sendcloud from the warehouse sender, the default sender, and refused', async () => {
    const answers = [
      await post('/fulfillment/carriers/AMAZON_BUY_SHIPPING/pickups', { scheduledFor: '2026-11-03' }),
      await post('/fulfillment/carriers/MANUAL/pickups', {}),
      await post('/fulfillment/carriers/MANUAL/pickups', { isRecurring: true }),
      await post('/fulfillment/carriers/MANUAL/pickups', { scheduledFor: '2026-11-03T09:00:00Z', windowStart: '09:00', windowEnd: '12:00', notes: 'Gate B' }),
      await post('/fulfillment/carriers/MANUAL/pickups', { isRecurring: true, daysOfWeek: 21, windowStart: '14:00' }),
      await post('/fulfillment/carriers/SENDCLOUD/pickups', { scheduledFor: '2026-11-04T09:00:00Z', warehouseId: 'test-wh', notes: 'Two parcels' }),
      await post('/fulfillment/carriers/SENDCLOUD/pickups', { scheduledFor: '2026-11-05T09:00:00Z' }),
    ]
    carrier.refuse = true
    answers.push(await post('/fulfillment/carriers/SENDCLOUD/pickups', { scheduledFor: '2026-11-06T09:00:00Z' }))
    carrier.refuse = false
    firstId = (await inside(() => database.client.pickupSchedule.findFirstOrThrow({ where: { carrierId: 'test-carrier-manual', isRecurring: false } }))).id
    expect([...answers, carrier.pickups]).toMatchSnapshot()
  })

  it('cancel, and a cancel of an unknown pickup', async () => {
    const cancelled = await post(`/fulfillment/carriers/MANUAL/pickups/${firstId}/cancel`)
    const unknown = await app.inject({ method: 'POST', url: '/api/fulfillment/carriers/MANUAL/pickups/test-pickup-none/cancel', payload: {} })
    expect([
      cancelled,
      unknown.statusCode,
      stable(await inside(() => database.client.pickupSchedule.findMany({ orderBy: [{ carrierId: 'asc' }, { scheduledFor: 'asc' }], select: { carrierId: true, status: true, isRecurring: true, daysOfWeek: true, scheduledFor: true, externalRef: true, lastDispatchErr: true } }))),
    ]).toMatchSnapshot()
  })
})
