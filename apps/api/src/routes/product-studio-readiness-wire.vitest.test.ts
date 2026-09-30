import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { decodeReadiness } from '@nexus/shared/readiness-wire'

const mocks = vi.hoisted(() => ({ readiness: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/pim/scope-readiness.service.js', () => ({ getProductReadiness: mocks.readiness }))
import routes from './product-studio.routes.js'

function fixture() {
  const productIds = Array.from({ length: 151 }, (_, i) => `synthetic-product-${i}`)
  const missing = productIds.map(productId => ({ productId, field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true, requiredBy: ['Example scope'] }))
  const optionalMissing = productIds.flatMap(productId => Array.from({ length: 30 }, (_, i) => ({ productId, field: `optional_${i}`, label: `Optional field ${i}` })))
  const summary = { id: 'EBAY', channel: 'EBAY', market: 'IT', accountId: 'synthetic-account', aliasId: null, coordinateKey: 'synthetic-coordinate', language: 'it',
    label: 'Example scope', state: 'blocked', pct: 50, required: { filled: 151, total: 302 }, optional: { filled: 0, total: 4530 }, mappingRules: 0,
    note: 'Example values are missing.', missing, optionalMissing, computedAt: '2026-09-30T10:00:00Z', pendingSince: '2026-09-30T10:01:00Z' }
  return { market: 'IT', locale: 'it', scopes: [summary], matrix: [{ ...summary,
    byProduct: Object.fromEntries(productIds.map(productId => [productId, { pct: 50, state: 'blocked', required: { filled: 1, total: 2 }, optional: { filled: 0, total: 30 },
      note: 'Example values are missing.', computedAt: '2026-09-30T10:00:00Z', pendingSince: '2026-09-30T10:01:00Z' }])) }], computedAt: '2026-09-30T10:00:00Z' }
}
let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(multipart); await app.register(routes); await app.ready() })
afterAll(() => app.close())
beforeEach(() => { mocks.readiness.mockReset().mockResolvedValue(fixture()) })
const url = '/products/synthetic-family/readiness?market=IT&locale=it&channel=EBAY&accountId=synthetic-account'

describe('compact readiness negotiation', () => {
  it('keeps the complete plain response unchanged for existing readers', async () => {
    const response = await app.inject(url)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(fixture())
    expect(Buffer.byteLength(response.body)).toBeGreaterThan(50_000)
  })
  it('fits a 151-row readiness response under the original 50,000-byte budget when requested', async () => {
    const response = await app.inject(`${url}&details=compact`)
    expect(response.statusCode).toBe(200)
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(50_000)
    expect(response.json().detailEncoding).toBe('readiness-details-v1')
    expect(decodeReadiness(response.json())).toEqual(fixture())
  })
  it('refuses an unknown encoding request before reading readiness', async () => {
    const response = await app.inject(`${url}&details=unknown`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('bad_details')
    expect(mocks.readiness).not.toHaveBeenCalled()
  })
  it('keeps coordinate selection independent from the requested wire format', async () => {
    const response = await app.inject(`${url}&only=coordinate&details=compact`)
    expect(response.statusCode).toBe(200)
    expect(mocks.readiness).toHaveBeenCalledExactlyOnceWith({ productId: 'synthetic-family', market: 'IT', locale: 'it', channel: 'EBAY', accountId: 'synthetic-account', onlyCoordinate: true })
  })
})
