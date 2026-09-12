import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'

const fixture = vi.hoisted(() => ({ sources: vi.fn(), files: vi.fn(), file: vi.fn(), reference: vi.fn(), upload: vi.fn() }))
vi.mock('../services/shopify/media-library.service.js', async original => ({ ...await original<object>(), mediaSources: fixture.sources, listShopifyFiles: fixture.files, getShopifyFile: fixture.file, referenceShopifyFile: fixture.reference, uploadShopifyFile: fixture.upload }))
vi.mock('../lib/auth/session.js', () => ({ validateSession: vi.fn(), truncateIp: () => 'fixture' }))
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn() }))
vi.mock('../lib/auth/rbac.js', () => ({ resolvePermissions: async (user: any) => ({ permissions: new Set(user.id === 'editor' ? ['assets.manage'] : ['products.view']) }), hasPermission: (resolved: any, permission: string) => resolved.permissions.has(permission) }))
import { shopifyMediaRoutes } from './shopify-media.routes'
import { rbacHook } from '../lib/auth/rbac-hook'
import { ShopifyMediaError } from '../services/shopify/media-library.service'
import { NoConnectionError } from '../services/connection-resolver.service'

let app: FastifyInstance
const headers = { authorization: 'editor' }
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  app = Fastify()
  app.addHook('onRequest', async request => { request.__sessionLoaded = true; if (request.headers.authorization) request.authUser = { id: request.headers.authorization, permissionsVersion: 1, roleKeys: [] } as any })
  app.addHook('preHandler', rbacHook)
  await app.register(multipart)
  await app.register(shopifyMediaRoutes, { prefix: '/api' }); await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => {
  vi.clearAllMocks()
  fixture.sources.mockResolvedValue({ stores: [], defaultSource: 'nexus' })
  fixture.files.mockResolvedValue({ accountId: 'a', items: [], nextCursor: null })
  fixture.reference.mockResolvedValue({ assetId: 'asset-a', url: 'https://cdn.shopify.com/file.jpg' })
  fixture.upload.mockResolvedValue({ file: { status: 'PROCESSING' } })
})
describe('Shopify media HTTP boundary', () => {
  it.each(['/api/assets/media-sources', '/api/assets/shopify/files?accountId=a'])('requires an authenticated asset manager for %s', async url => {
    expect((await app.inject({ url })).statusCode).toBe(401)
    expect((await app.inject({ url, headers: { authorization: 'viewer' } })).statusCode).toBe(403)
    expect((await app.inject({ url, headers })).statusCode).toBe(200)
  })
  it('does not permit viewer uploads or references', async () => {
    for (const path of ['upload', 'reference']) {
      expect((await app.inject({ method: 'POST', url: `/api/assets/shopify/${path}`, headers: { authorization: 'viewer' }, payload: {} })).statusCode).toBe(403)
    }
    expect(fixture.reference).not.toHaveBeenCalled(); expect(fixture.upload).not.toHaveBeenCalled()
  })
  it('forwards explicit store filters and prevents caching across profiles', async () => {
    const result = await app.inject({ url: '/api/assets/shopify/files?accountId=b&type=video&after=page2&search=summer', headers })
    expect(fixture.files).toHaveBeenCalledWith({ accountId: 'b', type: 'video', after: 'page2', search: 'summer' })
    expect(result.headers['cache-control']).toBe('private, no-store')
  })
  it('validates file identity and ignores no user-supplied storage URLs', async () => {
    const url = '/api/assets/shopify/reference'
    expect((await app.inject({ method: 'POST', url, headers, payload: { accountId: 'a', id: 'gid://shopify/Product/123' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, headers, payload: { accountId: 'a', id: 'gid://shopify/MediaImage/1', url: 'https://foreign.example/file.jpg' } })).statusCode).toBe(400)
    expect(fixture.reference).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url, headers, payload: { accountId: 'a', id: 'gid://shopify/MediaImage/1' } })).statusCode).toBe(200)
    expect(fixture.reference).toHaveBeenCalledWith('a', 'gid://shopify/MediaImage/1')
  })
  it('returns recoverable provider states and conceals foreign account details', async () => {
    fixture.files.mockRejectedValueOnce(new ShopifyMediaError('Reconnect the store.', 403))
    expect((await app.inject({ url: '/api/assets/shopify/files?accountId=a', headers })).json()).toEqual({ error: 'Reconnect the store.' })
    fixture.files.mockRejectedValueOnce(new NoConnectionError('Secret foreign account label'))
    const response = await app.inject({ url: '/api/assets/shopify/files?accountId=foreign', headers })
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain('Secret')
  })
  it('reports an upstream failure as a failure, never an empty success', async () => {
    fixture.files.mockRejectedValueOnce(new Error('upstream unavailable'))
    const result = await app.inject({ url: '/api/assets/shopify/files?accountId=a', headers })
    expect(result.statusCode).toBe(502); expect(result.json().items).toBeUndefined()
  })
  it('uploads only to the explicit store and preserves processing state', async () => {
    const boundary = 'media-test-boundary'
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="front.jpg"\r\nContent-Type: image/jpeg\r\n\r\nimage-bytes\r\n--${boundary}--\r\n`)
    const response = await app.inject({ method: 'POST', url: '/api/assets/shopify/upload?accountId=b', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
    expect(response.statusCode, response.body).toBe(200)
    expect(fixture.upload).toHaveBeenCalledWith('b', Buffer.from('image-bytes'), 'front.jpg')
    expect(response.json()).toMatchObject({ file: { status: 'PROCESSING' } })
  })
})
