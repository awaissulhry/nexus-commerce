/**
 * CX (main-session ruling 2026-09-26) — a pricing refusal is a configuration answer, not a server fault:
 * GET /pricing/explain answers with the refusal's own 4xx (400, as the codebase's market-currency refusal)
 * and its sentence. A real fault stays 500.
 */
import Fastify from 'fastify'
import { beforeEach, expect, it, vi } from 'vitest'

// A plain stand-in, not vi.fn(): the answer is set per case and every call is kept.
const h = vi.hoisted(() => ({ answer: null as null | (() => Promise<unknown>), calls: [] as unknown[][] }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: () => null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/pricing-engine.service.js', async (original) => ({ ...await original<object>(), resolvePrice: (...a: unknown[]) => { h.calls.push(a); return h.answer!() } }))

const routes = (await import('./pricing.routes.js')).default
const { FxRateMissingError } = await import('../services/fx-rate.service.js')

async function explain() {
  const app = Fastify()
  await app.register(routes)
  const result = await app.inject({ method: 'GET', url: '/pricing/explain?sku=A&channel=amazon&marketplace=uk' })
  await app.close()
  return result
}
beforeEach(() => { h.answer = null; h.calls = [] })

it('no FX rate → 400 with the refusal sentence and its code', async () => {
  h.answer = async () => { throw new FxRateMissingError('EUR', 'GBP', 'SKU A on AMAZON/UK') }
  const r = await explain()
  expect(r.statusCode).toBe(400)
  expect(r.json()).toMatchObject({ code: 'fx_rate_missing', error: expect.stringMatching(/No EUR→GBP exchange rate is stored/) })
})
it('no market currency → 400 with the refusal sentence', async () => {
  h.answer = async () => { throw Object.assign(new Error('No currency is configured for AMAZON/UK. Set it on the marketplace before pricing there.'), { statusCode: 400, code: 'market_currency_unconfigured' }) }
  const r = await explain()
  expect(r.statusCode).toBe(400)
  expect(r.json()).toMatchObject({ code: 'market_currency_unconfigured', error: expect.stringMatching(/No currency is configured/) })
})
it('a real fault is still a 500', async () => {
  h.answer = async () => { throw new Error('database went away') }
  expect((await explain()).statusCode).toBe(500)
})
it('a resolved price answers 200 (positive control)', async () => {
  h.answer = async () => ({ price: 8.5, currency: 'GBP' })
  const r = await explain()
  expect(r.statusCode).toBe(200)
  expect(h.calls).toEqual([[expect.anything(), { sku: 'A', channel: 'AMAZON', marketplace: 'UK', fulfillmentMethod: null }]])
})
