import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const db = vi.hoisted(() => ({
  digitalAsset: { findUnique: vi.fn() },
  assetLocaleOverlay: { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  brandStory: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (key: object) => ({ workspaceId: 'test-workspace', ...key }) }))
vi.mock('../services/cloudinary.service.js', () => ({ isCloudinaryConfigured: vi.fn(), uploadBufferToCloudinary: vi.fn() }))
vi.mock('../services/asset-quality.service.js', () => ({ checkAssetQuality: vi.fn() }))
vi.mock('../services/channel-variants.service.js', () => ({ buildAllVariants: vi.fn() }))
vi.mock('./shopify-media.routes.js', () => ({ shopifyMediaRoutes: async () => {} }))
vi.mock('../services/brand-story-amazon.service.js', () => ({ submitBrandStoryDocument: vi.fn(), submissionMode: vi.fn() }))
import assetsRoutes from './assets.routes.js'
import brandStoryRoutes from './brand-story.routes.js'

const app = Fastify()
beforeAll(async () => { await app.register(assetsRoutes); await app.register(brandStoryRoutes); await app.ready() })
afterAll(() => app.close())
beforeEach(() => {
  vi.resetAllMocks()
  db.digitalAsset.findUnique.mockResolvedValue({ id: 'asset' })
  db.assetLocaleOverlay.findMany.mockResolvedValue([])
  db.assetLocaleOverlay.upsert.mockImplementation(async ({ where, update }) => ({ id: 'overlay', locale: where.assetId_locale.locale, ...update }))
  db.brandStory.findMany.mockResolvedValue([])
  db.brandStory.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data }))
})

it('updates the existing regional overlay key while returning the language-only locale', async () => {
  db.assetLocaleOverlay.findMany.mockResolvedValue([{ id: 'regional', locale: 'it-IT' }])
  const response = await app.inject({ method: 'PUT', url: '/assets/da_asset/locale-overlays/it', payload: { text: ' Updated ' } })
  expect(response.statusCode).toBe(200)
  expect(response.json().overlay).toMatchObject({ locale: 'it', text: 'Updated' })
  expect(db.assetLocaleOverlay.findMany).toHaveBeenCalledWith({ where: { assetId: 'asset' } })
  expect(db.assetLocaleOverlay.upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { assetId_locale: { workspaceId: 'test-workspace', assetId: 'asset', locale: 'it-IT' } },
    create: expect.objectContaining({ assetId: 'asset', locale: 'it' }),
  }))
})

it('deletes the canonical overlay when canonical and regional keys coexist', async () => {
  db.assetLocaleOverlay.findMany.mockResolvedValue([{ id: 'regional', locale: 'it-IT' }, { id: 'canonical', locale: 'it' }, { id: 'sibling', locale: 'de' }])
  const response = await app.inject({ method: 'DELETE', url: '/assets/da_asset/locale-overlays/it-CH' })
  expect(response.statusCode).toBe(200)
  expect(db.assetLocaleOverlay.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: 'canonical' } })
})

it('does not delete another language or guess between two regional keys', async () => {
  db.assetLocaleOverlay.findMany.mockResolvedValue([{ id: 'sibling', locale: 'de' }])
  expect((await app.inject({ method: 'DELETE', url: '/assets/asset/locale-overlays/it' })).statusCode).toBe(404)
  db.assetLocaleOverlay.findMany.mockResolvedValue([{ id: 'one', locale: 'it-IT' }, { id: 'two', locale: 'it-CH' }])
  const ambiguous = await app.inject({ method: 'DELETE', url: '/assets/asset/locale-overlays/it' })
  expect(ambiguous.statusCode).toBe(500)
  expect(ambiguous.json().message).toBe('Ambiguous content addresses for it')
  expect(db.assetLocaleOverlay.delete).not.toHaveBeenCalled()
})

it('rejects a Brand Story for an existing language within the same brand and marketplace', async () => {
  db.brandStory.findMany.mockResolvedValue([{ id: 'regional-story', locale: 'it-IT' }])
  const response = await app.inject({ method: 'POST', url: '/brand-stories', payload: { name: 'Story', brand: ' XAVIA ', marketplace: ' IT ', locale: 'it' } })
  expect(response.statusCode).toBe(409)
  expect(response.json().existingId).toBe('regional-story')
  expect(db.brandStory.findMany).toHaveBeenCalledWith({ where: { brand: 'XAVIA', marketplace: 'IT' } })
  expect(db.brandStory.create).not.toHaveBeenCalled()
})

it('creates a different language as a canonical key', async () => {
  db.brandStory.findMany.mockResolvedValue([{ id: 'regional-story', locale: 'it-IT' }])
  const response = await app.inject({ method: 'POST', url: '/brand-stories', payload: { name: 'Story', brand: 'XAVIA', marketplace: 'IT', locale: 'de-DE' } })
  expect(response.statusCode).toBe(201)
  expect(response.json().story).toMatchObject({ id: 'created', locale: 'de' })
})

it('returns an existing regional localization without creating a sibling', async () => {
  db.brandStory.findUnique.mockResolvedValue({ id: 'source', brand: 'XAVIA', masterStoryId: null, modules: [] })
  db.brandStory.findMany.mockResolvedValue([{ id: 'regional-story', locale: 'fr-BE' }])
  const response = await app.inject({ method: 'POST', url: '/brand-stories/source/localize', payload: { marketplace: 'BE', locale: 'fr' } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ alreadyExisted: true, story: { id: 'regional-story', locale: 'fr' } })
  expect(db.brandStory.findMany).toHaveBeenCalledWith({ where: { brand: 'XAVIA', marketplace: 'BE' } })
  expect(db.$transaction).not.toHaveBeenCalled()
})
