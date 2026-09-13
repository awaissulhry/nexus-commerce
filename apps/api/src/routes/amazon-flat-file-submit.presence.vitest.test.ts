import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const upload = vi.fn()
  vi.stubGlobal('fetch', upload)
  return { upload, prepare: vi.fn(), build: vi.fn(), api: vi.fn(), sync: vi.fn() }
})
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/content-auto-publish.service.js', () => ({ enqueueContentSyncIfEnabled: vi.fn(), enqueueContentSyncForProduct: vi.fn() }))
vi.mock('../services/available-to-publish.service.js', () => ({ clampFollowingQtyRowsForFeed: async () => [] }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fixture-seller', amazonSpClient: () => ({ callAPI: m.api }) }))
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
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
let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(amazonFlatFileRoutes, { prefix: '/api' }); await app.ready() })
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  m.sync.mockResolvedValue({ created: 0, errors: [] })
  m.prepare.mockResolvedValue({ rows: [{ item_sku: 'PR1-FEED', skip_offer: 'true' }], refusals: [] })
  m.build.mockReturnValue({ body: '{}', messageCount: 1, skippedRows: [] })
  m.api.mockImplementation(async ({ operation }: { operation: string }) => operation === 'createFeedDocument'
    ? { url: 'https://fixture.invalid/upload', feedDocumentId: 'fixture-document' } : { feedId: 'fixture-feed' })
  m.upload.mockResolvedValue({ ok: true })
})
const submit = () => app.inject({ method: 'POST', url: '/api/amazon/flat-file/submit', payload: {
  marketplace: 'IT', rows: [{ item_sku: 'PR1-FEED', skip_offer: 'false' }],
} })

describe('the direct Amazon feed cannot bypass the stored push lock', () => {
  it('an ordinary unlocked feed is a reachable positive control', async () => {
    const response = await submit()
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ feedId: 'fixture-feed', dryRun: false })
    expect(m.api).toHaveBeenCalledTimes(2)
    expect(m.upload).toHaveBeenCalledOnce()
  })

  it('a stored lock refuses before building or sending a feed', async () => {
    const refusal = { sku: 'PR1-FEED', code: 'PUSH_SYNC_PAUSED', sentence: 'This listing is held. Resume it before sending changes.' }
    m.prepare.mockResolvedValue({ rows: [], refusals: [refusal] })
    const response = await submit()
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json()).toMatchObject({ error: refusal.sentence, refusal, refusals: [refusal] })
    expect(m.build).not.toHaveBeenCalled()
    expect(m.api).not.toHaveBeenCalled()
    expect(m.upload).not.toHaveBeenCalled()
  })

  it('a failed mandatory lock read cannot become the existing best-effort sync path', async () => {
    m.sync.mockRejectedValue(new Error('local sync unavailable'))
    m.prepare.mockRejectedValue(new Error('lock read unavailable'))
    const response = await submit()
    expect(response.statusCode, response.body).toBe(500)
    expect(m.prepare).toHaveBeenCalledOnce()
    expect(m.build).not.toHaveBeenCalled()
    expect(m.api).not.toHaveBeenCalled()
    expect(m.upload).not.toHaveBeenCalled()
  })

  it('the allowed control serializes the server-prepared rows, preserving skip_offer', async () => {
    const response = await submit()
    expect(response.statusCode, response.body).toBe(200)
    expect(m.prepare).toHaveBeenCalledWith([{ item_sku: 'PR1-FEED', skip_offer: 'false' }], 'IT')
    expect(m.build.mock.calls[0][0]).toEqual([{ item_sku: 'PR1-FEED', skip_offer: 'true' }])
    expect(m.api).toHaveBeenCalledTimes(2)
    expect(m.upload).toHaveBeenCalledOnce()
  })
})
