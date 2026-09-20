/**
 * P1.7 (Owner, 2026-09-20) — the Amazon flat-file submit route asks Amazon about every row before it
 * creates the feed. A row Amazon refuses is skipped with Amazon's own sentence and the good rows still
 * submit; every row refused means nothing is submitted at all. Above the row cap the sheet goes as
 * before. The feed body that leaves is recorded, so what was dropped is visible.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const upload = vi.fn()
  vi.stubGlobal('fetch', upload)
  return {
    upload, prepare: vi.fn(), build: vi.fn(), api: vi.fn(), sync: vi.fn(), preview: vi.fn(),
    refuse: new Map<string, string>(),
  }
})
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncIfEnabled: vi.fn(), enqueueContentSyncForProduct: vi.fn() }))
vi.mock('../services/available-to-publish.service.js', () => ({ clampFollowingQtyRowsForFeed: async () => [] }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fixture-seller', amazonSpClient: () => ({ callAPI: m.api }) }))
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    validateListing: vi.fn(async (options: any) => {
      m.preview(options)
      const refusal = m.refuse.get(String(options.sku))
      return { ok: !refusal, available: true, errors: refusal ?? null, warnings: [] }
    }),
  },
}))
vi.mock('../services/amazon/flat-file.service.js', () => ({
  AmazonFlatFileService: class {
    prepareRowsForPush = m.prepare
    buildJsonFeedBodyWithReport = m.build
    syncRowsToPlatform = m.sync
    findFbaQtyViolations = async () => []
  },
  MARKETPLACE_ID_MAP: { IT: 'fixture-market' }, flatFileExportColumns: vi.fn(), filterHiddenManifestColumns: vi.fn(), normalizeVariationTheme: vi.fn(),
}))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../db.js', () => ({ default: {
  channelListing: { findMany: async () => [] },
  amazonFlatFileFeedJob: { create: async () => ({ id: 'fixture-job' }) },
} }))

import amazonFlatFileRoutes from './amazon-flat-file.routes.js'

const message = (sku: string) => ({ messageId: sku, sku, operationType: 'UPDATE', productType: 'COAT', attributes: { item_name: [{ value: sku }] } })
const feed = (skus: string[]) => JSON.stringify({ header: { sellerId: 'fixture-seller', version: '2.0' }, messages: skus.map(message) })
const uploadedSkus = () => JSON.parse(String(m.upload.mock.calls[0][1].body)).messages.map((msg: any) => msg.sku)

let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(amazonFlatFileRoutes, { prefix: '/api' }); await app.ready() })
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })

beforeEach(() => {
  vi.clearAllMocks(); m.refuse = new Map()
  vi.stubEnv('NEXUS_AMAZON_FLAT_FILE_PREVIEW_CAP', '200')
  m.sync.mockResolvedValue({ created: 0, errors: [] })
  m.prepare.mockImplementation(async (rows: any[]) => ({ rows, refusals: [] }))
  m.build.mockImplementation((rows: any[]) => ({ body: feed(rows.map((row) => String(row.item_sku))), messageCount: rows.length, skippedRows: [] }))
  m.api.mockImplementation(async ({ operation }: { operation: string }) => operation === 'createFeedDocument'
    ? { url: 'https://fixture.invalid/upload', feedDocumentId: 'fixture-document' } : { feedId: 'fixture-feed' })
  m.upload.mockResolvedValue({ ok: true })
})

const submit = (skus: string[]) => app.inject({ method: 'POST', url: '/api/amazon/flat-file/submit', payload: {
  marketplace: 'IT', rows: skus.map((sku) => ({ item_sku: sku })),
} })

describe('P1.7 — the Amazon flat-file route asks Amazon first', () => {
  it('DONE-WHEN: every row is previewed with its own attributes, then the sheet submits', async () => {
    const res = await submit(['A', 'B'])
    expect(res.statusCode).toBe(200)
    expect(m.preview).toHaveBeenCalledTimes(2)
    expect(m.preview.mock.calls.map((call) => call[0].sku)).toEqual(['A', 'B'])
    expect(m.preview.mock.calls[0][0]).toMatchObject({ sellerId: 'fixture-seller', marketplaceId: 'fixture-market', productType: 'COAT' })
    expect(uploadedSkus()).toEqual(['A', 'B'])
    expect(res.json()).toMatchObject({ messageCount: 2, skippedRows: [] })
  })
  it('Amazon refuses one row: it is dropped with Amazon\'s sentence, the rest still go', async () => {
    m.refuse.set('B', 'Item specific Size is missing')
    const res = await submit(['A', 'B', 'C'])
    expect(res.statusCode).toBe(200)
    expect(uploadedSkus()).toEqual(['A', 'C'])
    const body = res.json()
    expect(body.messageCount).toBe(2)
    expect(body.skippedRows).toEqual([{ sku: 'B', error: expect.stringContaining('Item specific Size is missing') }])
  })
  it('Amazon refuses every row: nothing is created, nothing is uploaded', async () => {
    m.refuse.set('A', 'Invalid value').set('B', 'Invalid value')
    const res = await submit(['A', 'B'])
    expect(res.statusCode).toBe(400)
    expect(res.json().skippedRows).toHaveLength(2)
    expect(m.api).not.toHaveBeenCalled()
    expect(m.upload).not.toHaveBeenCalled()
  })
  it('above the row cap: no preview at all, the sheet goes as before', async () => {
    vi.stubEnv('NEXUS_AMAZON_FLAT_FILE_PREVIEW_CAP', '1')
    const res = await submit(['A', 'B'])
    expect(res.statusCode).toBe(200)
    expect(m.preview).not.toHaveBeenCalled()
    expect(uploadedSkus()).toEqual(['A', 'B'])
  })
  it('the push lock still runs first: a refused row never reaches the preview', async () => {
    m.prepare.mockResolvedValue({ rows: [], refusals: [{ sku: 'A', code: 'PUSH_LISTING_ENDED', sentence: 'This listing is ended on the channel.' }] })
    const res = await submit(['A'])
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ refusal: { code: 'PUSH_LISTING_ENDED' } })
    expect(m.preview).not.toHaveBeenCalled()
    expect(m.api).not.toHaveBeenCalled()
  })
})
