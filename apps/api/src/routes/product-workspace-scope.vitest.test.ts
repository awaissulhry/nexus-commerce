import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'

const mocks = vi.hoisted(() => ({ sheet: vi.fn(), readiness: vi.fn(), createAlias: vi.fn(), updateAlias: vi.fn(), archiveAlias: vi.fn(), readJob: vi.fn(), applyJob: vi.fn(), revertJob: vi.fn(), storePreview: vi.fn(), computeDiff: vi.fn(), destination: vi.fn(), listingDestination: vi.fn(), listSnapshots: vi.fn(), bulk: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/pim/studio-sheet.service.js', () => ({
  getStudioSheet: mocks.sheet, UnknownProductError: class extends Error {}, ScopeNotAvailableError: class extends Error {},
}))
vi.mock('../services/pim/scope-readiness.service.js', () => ({ getProductReadiness: mocks.readiness }))
vi.mock('../services/pim/sheet-columns.service.js', () => ({ getSheetColumns: vi.fn(), UnknownMarketError: class extends Error {} }))
vi.mock('../services/pim/restore-points.service.js', () => ({ getRestorePoints: vi.fn() }))
vi.mock('../services/pim/cell-history.service.js', () => ({ getCellHistory: vi.fn() }))
vi.mock('../services/pim/sync-queue.service.js', () => ({ getProductSyncQueue: vi.fn() }))
vi.mock('../services/pim/import-diff.service.js', async importOriginal => ({ ...await importOriginal<object>(), computeImportDiff: mocks.computeDiff }))
vi.mock('../services/pim/import-jobs.service.js', () => ({ readJob: mocks.readJob, applyStoredJob: mocks.applyJob, revertStoredJob: mocks.revertJob, storePreview: mocks.storePreview, JobNotApplicableError: class extends Error {} }))
vi.mock('../services/pim/listing-snapshot.service.js', () => ({ captureSnapshot: vi.fn(), listSnapshots: mocks.listSnapshots, restoreToDraft: vi.fn(), SnapshotCoordinateMismatchError: class extends Error {}, SnapshotNotFoundError: class extends Error {} }))
vi.mock('../services/pim/listing-alias.service.js', () => ({ createAlias: mocks.createAlias, updateAlias: mocks.updateAlias, archiveAlias: mocks.archiveAlias, AliasCreationBlockedError: class extends Error {}, AliasNotFoundError: class extends Error {}, AliasScopeMismatchError: class extends Error { code = 'LISTING_SCOPE_MISMATCH' } }))
vi.mock('../services/pim/workspace-destination.js', async original => ({ ...await original<object>(), resolveWorkspaceDestination: mocks.destination, resolveWorkspaceListing: mocks.listingDestination }))
vi.mock('../lib/auth/session.js', () => ({ validateSession: vi.fn(), truncateIp: () => 'fixture' }))
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn() }))
vi.mock('../lib/auth/rbac.js', () => ({ resolvePermissions: async (user: any) => ({ permissions: new Set(user.id === 'editor' ? ['products.view', 'products.edit'] : ['products.view']) }), hasPermission: (resolved: any, permission: string) => resolved.permissions.has(permission) }))
import { rbacHook } from '../lib/auth/rbac-hook.js'
import routes from './product-studio.routes.js'


let app: FastifyInstance
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    if (request.headers.authorization) request.authUser = { id: request.headers.authorization, permissionsVersion: 1, roleKeys: [] } as any
  })
  app.addHook('preHandler', rbacHook)
  await app.register(multipart)
  await app.register(routes, { prefix: '/api' })
  app.patch('/api/products/bulk', async (request, reply) => {
    mocks.bulk(request.body, request.headers.authorization)
    if ((request.body as any).expectedVersion !== 7) return reply.code(409).send({ error: 'Version conflict' })
    return { success: true, currentVersion: 8, versionOf: 'channelListing' }
  })
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.destination.mockResolvedValue({ productId: 'p', familyId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'b', aliasKey: 'alt', listing: { id: 'b-alt', productId: 'p' } })
  mocks.listingDestination.mockResolvedValue({ productId: 'p', accountId: 'b' })
  mocks.listSnapshots.mockResolvedValue([])
  mocks.sheet.mockResolvedValue({ rows: [{ id: 'p', aliasId: 'alt', values: { title: { editable: true, writeTarget: 'channelListing', writeField: 'ebay_title' } } }] })
})
describe('registered workspace routes preserve RBAC and canonical reset ownership', () => {
  it.each(['destination', 'activity', 'performance'])('rejects anonymous %s before reading', async view => {
    const response = await app.inject(`/api/products/p/studio/${view}?channel=EBAY&market=IT&accountId=b`)
    expect(response.statusCode).toBe(401)
    expect(mocks.destination).not.toHaveBeenCalled()
  })
  it('allows product viewers to validate scope without audit access', async () => {
    const response = await app.inject({ url: '/api/products/p/studio/destination?channel=EBAY&market=IT&accountId=b&listingId=b-alt', headers: { authorization: 'viewer' } })
    expect(response.statusCode).toBe(200)
    expect(mocks.destination).toHaveBeenCalledWith(expect.objectContaining({ productId: 'p', accountId: 'b', listingId: 'b-alt' }))
  })
  it('binds snapshot history to the validated product and account', async () => {
    const response = await app.inject({ url: '/api/products/p/listings/b-alt/snapshots?accountId=b', headers: { authorization: 'viewer' } })
    expect(response.statusCode).toBe(200)
    expect(mocks.listingDestination).toHaveBeenCalledWith('p', 'b-alt', 'b')
    expect(mocks.listSnapshots).toHaveBeenCalledWith('b-alt', undefined, { productId: 'p', accountId: 'b' })
  })
  it('rejects a viewer’s override reset before both sheet read and canonical write', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/products/p/overrides/title?channel=EBAY&market=IT&accountId=b&aliasKey=alt&expectedVersion=7', headers: { authorization: 'viewer' } })
    expect(response.statusCode).toBe(403)
    expect(mocks.sheet).not.toHaveBeenCalled(); expect(mocks.bulk).not.toHaveBeenCalled()
  })
  it('carries exact context, reset intent and actor into the existing canonical writer', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/products/p/overrides/title?channel=EBAY&market=IT&accountId=b&aliasKey=alt&expectedVersion=7', headers: { authorization: 'editor' } })
    expect(response.statusCode, response.body).toBe(200)
    expect(mocks.bulk).toHaveBeenCalledWith({ expectedVersion: 7, changes: [{ id: 'p', field: 'ebay_title', value: null, intent: 'reset', target: 'channel' }], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: 'b', aliasKey: 'alt' }] }, 'editor')
    expect(response.json()).toMatchObject({ currentVersion: 8, versionOf: 'channelListing' })
  })
  it('preserves a canonical conflict and requires an observed version', async () => {
    const url = '/api/products/p/overrides/title?channel=EBAY&market=IT&accountId=b&aliasKey=alt'
    expect((await app.inject({ method: 'DELETE', url, headers: { authorization: 'editor' } })).statusCode).toBe(400)
    expect(mocks.bulk).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'DELETE', url: `${url}&expectedVersion=6`, headers: { authorization: 'editor' } })).statusCode).toBe(409)
  })
  it('refuses fields owned outside the listing override writer', async () => {
    mocks.sheet.mockResolvedValue({ rows: [{ id: 'p', aliasId: 'alt', values: { stock: { editable: true, writeTarget: 'product', writeField: 'totalStock' } } }] })
    const response = await app.inject({ method: 'DELETE', url: '/api/products/p/overrides/stock?channel=EBAY&market=IT&accountId=b&aliasKey=alt&expectedVersion=7', headers: { authorization: 'editor' } })
    expect(response.statusCode).toBe(400); expect(mocks.bulk).not.toHaveBeenCalled()
  })
})
