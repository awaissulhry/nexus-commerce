/**
 * MCP full control 07 O1 — the operator cancel (`POST /api/orders/:id/cancel`), three defects found on main:
 *
 *   1. The status write was not a compare-and-swap: the route read the order, checked its status, then wrote
 *      CANCELLED by id alone. A channel sync (or a second cancel) that moved the order in between was overwritten:
 *      a SHIPPED order became CANCELLED and its cascade ran.
 *   2. PARTIALLY_SHIPPED passed the "too far" check: part of the parcel had left, yet the order was cancelled.
 *   3. The Amazon market map had 6 markets and sent every other market (NL, BE, SE, PL, IE, …) with the ITALIAN
 *      marketplace id. Now the id comes from `amazonMarketplaceIdFor`; a market with no known id is refused before
 *      anything changes.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin; the channel call is a spy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>

// A hook that runs once, right after the route's first read of an order: the moment a concurrent writer can move it.
const race = vi.hoisted(() => ({ afterFirstOrderRead: null as null | (() => Promise<void>) }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(database.client, property)
      if (property !== 'order') return value
      return new Proxy(value as object, {
        get: (delegate, method) => {
          const fn = Reflect.get(delegate, method)
          if (method !== 'findUnique' || typeof fn !== 'function') return typeof fn === 'function' ? fn.bind(delegate) : fn
          return async (args: unknown) => {
            const row = await fn.call(delegate, args)
            const hook = race.afterFirstOrderRead
            race.afterFirstOrderRead = null
            if (hook) await hook()
            return row
          }
        },
      })
    },
  }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})
const channel = vi.hoisted(() => ({ amazon: [] as unknown[][] }))
vi.mock('../services/order-cancellation/channel-cancel.js', () => ({
  cancelOnAmazon: vi.fn(async (...args: unknown[]) => {
    channel.amazon.push(args)
    return { ok: true, channel: 'AMAZON', channelOrderId: String(args[0]), ackRef: null, dryRun: true }
  }),
  cancelOnEbay: vi.fn(async () => { throw new Error('not expected in this suite') }),
  cancelOnShopify: vi.fn(async () => { throw new Error('not expected in this suite') }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('07 O1 — operator cancel: compare-and-swap, PARTIALLY_SHIPPED, Amazon marketplace id', () => {
  let app: FastifyInstance
  let seq = 0

  const order = (data: Record<string, unknown>) => inside(async () => (await database.client.order.create({
    data: {
      channel: 'MANUAL', channelOrderId: `TEST-O1-CANCEL-${++seq}`, marketplace: 'IT', status: 'PROCESSING',
      currencyCode: 'EUR', totalPrice: '10.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test',
      shippingAddress: { city: 'Milano' }, purchaseDate: new Date(), ...data,
    } as never,
  })).id)
  const statusOf = (id: string) => inside(() => database.client.order.findUnique({ where: { id }, select: { status: true, cancelledAt: true } }))
  const cancel = (id: string) => app.inject({ method: 'POST', url: `/api/orders/${id}/cancel`, payload: {} })

  beforeAll(async () => {
    database = await formulaDatabase()
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { ordersRoutes } = await import('./orders.routes.js')
    await app.register(ordersRoutes)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  beforeEach(() => {
    race.afterFirstOrderRead = null
    channel.amazon.length = 0
  })

  it('control: a PROCESSING order is cancelled', async () => {
    const id = await order({})
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(200)
    expect((await statusOf(id))?.status).toBe('CANCELLED')
  })

  it('refuses a PARTIALLY_SHIPPED order and changes nothing', async () => {
    const id = await order({ status: 'PARTIALLY_SHIPPED' })
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('ORDER_TOO_FAR')
    expect(await statusOf(id)).toEqual({ status: 'PARTIALLY_SHIPPED', cancelledAt: null })
  })

  it('a status change between the read and the write wins: the cancel is refused, the order stays SHIPPED', async () => {
    const id = await order({ status: 'PROCESSING' })
    // A channel sync marks the order shipped right after the route has read it as PROCESSING.
    race.afterFirstOrderRead = async () => {
      await inside(() => database.client.order.update({ where: { id }, data: { status: 'SHIPPED', shippedAt: new Date() } }))
    }
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().code).toBe('ORDER_CHANGED')
    expect(await statusOf(id)).toEqual({ status: 'SHIPPED', cancelledAt: null })
  })

  it('an Amazon NL order is cancelled with the NL marketplace id, not the Italian one', async () => {
    const id = await order({ channel: 'AMAZON', marketplace: 'NL', channelOrderId: 'TEST-AMZ-NL-1', fulfillmentMethod: 'FBM' })
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(200)
    expect(channel.amazon).toEqual([['TEST-AMZ-NL-1', 'Cancelled by operator', ['A1805IZSGTT6HS']]])
  })

  it.each([['XX'], [null]])('an Amazon order whose market (%s) has no known id is refused before anything changes', async (marketplace) => {
    const id = await order({ channel: 'AMAZON', marketplace, channelOrderId: `TEST-AMZ-UNKNOWN-${++seq}`, fulfillmentMethod: 'FBM' })
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('UNKNOWN_AMAZON_MARKETPLACE')
    expect(await statusOf(id)).toEqual({ status: 'PROCESSING', cancelledAt: null })
    expect(channel.amazon).toEqual([])
  })

  // 07 O10 (RED before): an order Amazon ships (FBA, or an MCF request alive) and a RETURNED or REFUNDED order were
  // cancelled — the stock restored and the channel told — though Amazon fulfils the first and the second is past selling.
  it.each([
    ['an FBA order', { channel: 'AMAZON', marketplace: 'IT', channelOrderId: 'TEST-AMZ-FBA-1', fulfillmentMethod: 'FBA' }, 'AMAZON_FULFILLED'],
    ['a RETURNED order', { status: 'RETURNED' }, 'ORDER_TOO_FAR'],
    ['a REFUNDED order', { status: 'REFUNDED' }, 'ORDER_TOO_FAR'],
  ])('refuses %s and changes nothing', async (_label, data, code) => {
    const id = await order(data)
    const before = await statusOf(id)
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe(code)
    expect(await statusOf(id)).toEqual(before)
    expect(channel.amazon).toEqual([])
  })

  it('refuses an eBay order sent to Amazon Multi-Channel Fulfilment (a live MCF request) and changes nothing', async () => {
    const id = await order({ channel: 'EBAY', fulfillmentMethod: 'MFN' })
    await inside(() => database.client.mCFShipment.create({ data: { orderId: id, amazonFulfillmentOrderId: `TEST-MCF-CANCEL-${seq}`, status: 'PROCESSING' } }))
    const response = await cancel(id)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('AMAZON_FULFILLED')
    expect(await statusOf(id)).toEqual({ status: 'PROCESSING', cancelledAt: null })
  })
})
