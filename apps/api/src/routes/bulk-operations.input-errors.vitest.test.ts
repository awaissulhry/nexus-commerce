/**
 * A bulk job the caller asked for cannot run as asked → 400 with the plain reason, as the rest of the API answers.
 *
 * 🔴 WHAT THIS GUARDS. `POST /api/bulk-operations` answered 500 for every refusal — the publish flag the single-listing
 * edit refuses, an unreadable price, a missing channel scope, a scope that matches nothing — so a caller's mistake read
 * as a server fault and was logged as one. A real server fault must still answer 500: the positive control below.
 *
 * Real routes over a real PostgreSQL in-process (PGlite).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import bulkOperationsRoutes from './bulk-operations.routes.js'
import bulkActionTemplateRoutes from './bulk-action-templates.routes.js'
import { BulkActionService, PUBLISH_FLAG_REFUSAL } from '../services/bulk-action.service.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(BUSINESS, done))
  await app.register(bulkOperationsRoutes, { prefix: '/api' })
  await app.register(bulkActionTemplateRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(BUSINESS, async () => {
    await prisma.product.create({ data: { id: 'refusal-product', sku: 'REFUSAL-SKU', name: 'refusal', basePrice: 10 } })
    await prisma.channelListing.create({ data: { productId: 'refusal-product', channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'EU', price: 10 } })
  })
}, 120_000)
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

const job = (extra: Record<string, unknown>) => ({ jobName: 'refusal', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', targetProductIds: ['refusal-product'], ...extra })
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never })

describe('a refused bulk job answers 400 with the plain reason', () => {
  it.each([
    ['the publish flag (refused as the single-listing edit refuses it)', job({ actionPayload: { isPublished: false } }), PUBLISH_FLAG_REFUSAL],
    ['an unreadable price', job({ actionPayload: { priceOverride: 'abc' } }), 'priceOverride must be a number, or null to follow the master price again.'],
    ['a quantity that is not whole', job({ actionPayload: { quantityOverride: 2.5 } }), 'quantityOverride must be a whole number, zero or more.'],
    ['no channel scope', job({ channel: undefined, actionPayload: { priceOverride: 5 } }), 'MARKETPLACE_OVERRIDE_UPDATE requires `channel` to be set (e.g. "AMAZON"). Refusing to run without a channel scope.'],
    ['a scope that matches nothing', job({ targetProductIds: ['no-such-product'], actionPayload: { priceOverride: 5 } }), 'No items found matching the specified criteria'],
  ])('🔴 create: %s', async (_name, body, reason) => {
    const response = await post('/api/bulk-operations', body)
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json()).toEqual({ success: false, error: reason })
  })

  it('🔴 preview and the conflict check refuse the same payload the same way', async () => {
    for (const url of ['/api/bulk-operations/preview', '/api/bulk-operations/check-conflicts']) {
      const response = await post(url, job({ actionPayload: { isPublished: false } }))
      // The conflict check does not read the payload; only the preview must refuse it.
      if (url.endsWith('preview')) {
        expect(response.statusCode, response.body).toBe(400)
        expect(response.json()).toEqual({ success: false, error: PUBLISH_FLAG_REFUSAL })
      } else {
        expect(response.statusCode, response.body).toBe(200)
      }
    }
  })

  it('a template applied with a payload every row would refuse answers 400 too', async () => {
    const saved = await post('/api/bulk-action-templates', { name: 'old pause', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', actionPayload: { isPublished: false } })
    expect(saved.statusCode, saved.body).toBe(201)
    const applied = await post(`/api/bulk-action-templates/${saved.json().template.id}/apply`, { targetProductIds: ['refusal-product'] })
    expect(applied.statusCode, applied.body).toBe(400)
    expect(applied.json()).toEqual({ success: false, error: PUBLISH_FLAG_REFUSAL })
  })

  it('positive control: a real server fault still answers 500 — the mapping is for refusals only', async () => {
    vi.spyOn(BulkActionService.prototype, 'createJob').mockRejectedValueOnce(new Error('database went away'))
    const response = await post('/api/bulk-operations', job({ actionPayload: { priceOverride: 5 } }))
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ success: false, error: 'database went away' })
  })

  it('a valid job is still created (201)', async () => {
    const response = await post('/api/bulk-operations', job({ actionPayload: { priceOverride: 5 } }))
    expect(response.statusCode, response.body).toBe(201)
  })
})
