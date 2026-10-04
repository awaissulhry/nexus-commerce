/**
 * One-click O5 — the publication batch routes hand the request to the service and its refusals back with their words.
 * `POST /api/publication-batches/listed-markets` answers where the chosen products are listed (the products list's
 * Publish window starts with those markets); the static path is not mistaken for a batch id.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const calls: Array<{ name: string; args: unknown[] }> = []
vi.mock('../services/pim/publication-batch.service.js', async () => {
  const { WorkspaceScopeError } = await import('../services/pim/workspace-destination.js')
  return {
    listedMarkets: async (body: { productIds?: unknown }) => {
      calls.push({ name: 'listedMarkets', args: [body] })
      if (!Array.isArray(body.productIds) || !body.productIds.length) throw new WorkspaceScopeError('Choose at least one product.', 400)
      return { families: 1, markets: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', families: 1 }] }
    },
    readPublicationBatch: async (id: string) => { calls.push({ name: 'readPublicationBatch', args: [id] }); return { batchId: id } },
    createPublicationBatch: async () => ({ batchId: 'b1' }),
    submitReviewedBatch: async () => ({}),
    cancelPublicationBatch: async () => ({}),
  }
})

let app: FastifyInstance
beforeAll(async () => {
  const { default: routes } = await import('./publication-batches.routes.js')
  app = Fastify()
  await app.register(routes, { prefix: '/api' })
})
afterAll(async () => { await app?.close() })

describe('publication batch routes (One-click O5)', () => {
  it('listed markets: answers where the chosen products are listed, uncached', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/publication-batches/listed-markets', payload: { productIds: ['p1'] } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ families: 1, markets: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', families: 1 }] })
    expect(calls.at(-1)).toEqual({ name: 'listedMarkets', args: [{ productIds: ['p1'] }] })
  })

  it('listed markets: a refusal keeps its status and words', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/publication-batches/listed-markets', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_request', message: 'Choose at least one product.' })
  })

  it('a batch id is still read by GET', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/publication-batches/b-42' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ batchId: 'b-42' })
  })
})
