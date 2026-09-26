/**
 * P7 (docs/attributes/PLAN.md §10.8) — `GET /api/products/readiness/missing-required` checks its input and hands the
 * query to the service; the service's own behaviour is `services/pim/readiness-query.vitest.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const query = vi.hoisted(() => vi.fn(async () => ({ productIds: [], pendingProductIds: [], checkedProducts: 0, pendingProducts: 0, nextCursor: null })))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => ({ findMany: async () => [], count: async () => 0 }) }) }))
vi.mock('../services/pim/readiness-query.service.js', () => ({ MISSING_REQUIRED_MAX_TAKE: 1000, productsMissingRequired: query }))

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register((await import('./families.routes.js')).default, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => query.mockClear())
const get = (qs: string) => app.inject({ method: 'GET', url: `/api/products/readiness/missing-required${qs}` })

describe('GET /api/products/readiness/missing-required', () => {
  it('passes a channel coordinate through, normalised', async () => {
    const res = await get('?channel=ebay&market=de&language=DE&field=color&requiredBy=Family:%20Jackets&take=50&after=p9&accountId=acc-1')
    expect(res.statusCode).toBe(200)
    expect(query).toHaveBeenCalledWith({ channel: 'EBAY', market: 'DE', language: 'de', field: 'color', requiredBy: 'Family: Jackets', take: 50, after: 'p9', accountId: 'acc-1' })
  })
  it('reads no channel and no market as the shared product, and leaves the account out unless asked', async () => {
    expect((await get('')).statusCode).toBe(200)
    expect(query).toHaveBeenCalledWith({ channel: null, market: null, language: null, field: null, requiredBy: null, take: undefined, after: null })
  })
  it('reads an empty accountId as "rows with no account"', async () => {
    await get('?channel=EBAY&market=DE&accountId=')
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ accountId: null }))
  })
  it.each([['?channel=EBAY', 'channel without market'], ['?market=DE', 'market without channel'], ['?channel=EBAY&market=DE&take=0', 'take 0'],
    ['?channel=EBAY&market=DE&take=1001', 'take above the cap'], ['?channel=EBAY&market=DE&take=2.5', 'a fraction']])('refuses %s (%s)', async qs => {
    const res = await get(qs)
    expect(res.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
})
