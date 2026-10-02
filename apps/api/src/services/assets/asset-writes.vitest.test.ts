/**
 * MCP full control P7 — the image library writes Claude's organize-image-library uses (an asset's label, its tags,
 * moving assets between folders) moved from assets.routes.ts into asset-library.service.ts. PATCH /api/assets/:id,
 * PUT /api/assets/:id/tags and POST /api/assets/move answer byte for byte what they answered before (goldens recorded
 * on the routes as they were), with business profiles off and on; the folder and tag reads after the writes show what
 * they stored.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
// No Redis here: the queues are built at import time and would try to connect. These writes never enqueue.
vi.mock('../../lib/queue.js', () => ({
  redis: { connection: null }, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: null, bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null,
  addJobSafely: vi.fn(), resetEnqueueCircuitForTests: vi.fn(), initializeQueue: vi.fn(), closeQueue: vi.fn(),
  getQueueStats: vi.fn(), getRedisRuntimeStatus: vi.fn(() => ({ configured: false, status: 'not-initialized' })), resolveRedisTarget: vi.fn(),
}))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import assetsRoutes from '../../routes/assets.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
/** A tag the route creates from a name gets a random id: the golden holds its place. */
const createdIds = (body: string) => body.replace(/"c[a-z0-9]{20,}"/g, '"<created id>"')

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.assetFolder.create({ data: { id: 'golden-folder-a', name: 'Lookbook', createdAt: at(300), updatedAt: at(300) } })
    await db.assetFolder.create({ data: { id: 'golden-folder-b', name: 'Packshots', createdAt: at(290), updatedAt: at(290) } })
    await db.tag.create({ data: { id: 'golden-tag-red', name: 'red', createdAt: at(300), updatedAt: at(300) } })
    await db.tag.create({ data: { id: 'golden-tag-blue', name: 'blue', createdAt: at(300), updatedAt: at(300) } })
    const asset = (id: string, label: string, extra: Record<string, unknown> = {}) =>
      db.digitalAsset.create({
        data: { id, label, code: null, type: 'image', mimeType: 'image/jpeg', sizeBytes: 1000, storageId: `golden/${id}`, url: `https://example.test/${id}.jpg`, createdAt: at(200), updatedAt: at(200), ...extra },
      })
    await asset('golden-asset-1', 'Jacket front', { folderId: 'golden-folder-a', code: 'jacket_front' })
    await asset('golden-asset-2', 'Jacket back', { folderId: 'golden-folder-a' })
    await asset('golden-asset-3', 'Gloves', {})
    await db.assetTag.create({ data: { assetId: 'golden-asset-1', tagId: 'golden-tag-red' } })
  })
  app = await goldenApp([{ plugin: assetsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P7 — asset label: PATCH /api/assets/:id answers exactly as before', () => {
  it('a new label, refusals, and an asset that is not there', async () => {
    await expectGolden(app, 'asset-label', '/api/assets/golden-asset-2', GOLDEN, { method: 'PATCH', payload: { label: '  Jacket back, studio  ' } })
    await expectGolden(app, 'asset-label-empty', '/api/assets/golden-asset-2', GOLDEN, { method: 'PATCH', payload: { label: '   ' } })
    await expectGolden(app, 'asset-code-bad', '/api/assets/golden-asset-2', GOLDEN, { method: 'PATCH', payload: { code: 'Not Snake' } })
    await expectGolden(app, 'asset-code-taken', '/api/assets/golden-asset-2', GOLDEN, { method: 'PATCH', payload: { code: 'jacket_front' } })
    await expectGolden(app, 'asset-code-metadata', '/api/assets/golden-asset-3', GOLDEN, { method: 'PATCH', payload: { code: '', metadata: { alt: 'Gloves on white' } } })
    await expectGolden(app, 'asset-nothing', '/api/assets/golden-asset-2', GOLDEN, { method: 'PATCH', payload: {} })
    await expectGolden(app, 'asset-missing', '/api/assets/golden-asset-none', GOLDEN, { method: 'PATCH', payload: { label: 'x' } })
  })
})

describe('P7 — asset tags: PUT /api/assets/:id/tags answers exactly as before', () => {
  it('by ids, by names (one new), cleared, and an asset that is not there', async () => {
    await expectGolden(app, 'tags-by-id', '/api/assets/golden-asset-2/tags', GOLDEN, { method: 'PUT', payload: { tagIds: ['golden-tag-blue', 'golden-tag-red'] } })
    await expectGolden(app, 'tags-by-name', '/api/assets/golden-asset-3/tags', GOLDEN, { method: 'PUT', payload: { tagIds: ['golden-tag-red'], tagNames: ['blue', ' green ', ''] }, normalize: createdIds })
    await expectGolden(app, 'tags-cleared', '/api/assets/golden-asset-1/tags', GOLDEN, { method: 'PUT', payload: {} })
    await expectGolden(app, 'tags-missing', '/api/assets/golden-asset-none/tags', GOLDEN, { method: 'PUT', payload: { tagIds: [] } })
    await expectGolden(app, 'tags-after', '/api/asset-tags', GOLDEN, { normalize: createdIds })
  })
})

describe('P7 — moving assets: POST /api/assets/move answers exactly as before', () => {
  it('refusals, into a folder, and back to unfiled', async () => {
    await expectGolden(app, 'move-no-ids', '/api/assets/move', GOLDEN, { method: 'POST', payload: { folderId: 'golden-folder-b' } })
    await expectGolden(app, 'move-bad-folder', '/api/assets/move', GOLDEN, { method: 'POST', payload: { assetIds: ['golden-asset-1'], folderId: 'golden-folder-none' } })
    await expectGolden(app, 'move-to-folder', '/api/assets/move', GOLDEN, { method: 'POST', payload: { assetIds: ['golden-asset-1', 'golden-asset-3', 'golden-asset-none'], folderId: 'golden-folder-b' } })
    await expectGolden(app, 'move-unfiled', '/api/assets/move', GOLDEN, { method: 'POST', payload: { assetIds: ['golden-asset-2'], folderId: null } })
    await expectGolden(app, 'folders-after', '/api/asset-folders', GOLDEN)
  })
})
