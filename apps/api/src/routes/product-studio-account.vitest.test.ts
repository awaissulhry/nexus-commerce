import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'

const mocks = vi.hoisted(() => ({ sheet: vi.fn(), readiness: vi.fn(), createAlias: vi.fn(), updateAlias: vi.fn(), archiveAlias: vi.fn(), readJob: vi.fn(), applyJob: vi.fn(), revertJob: vi.fn(), storePreview: vi.fn(), computeDiff: vi.fn() }))
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
vi.mock('../services/pim/listing-snapshot.service.js', () => ({ captureSnapshot: vi.fn(), listSnapshots: vi.fn(), restoreToDraft: vi.fn(), SnapshotCoordinateMismatchError: class extends Error {}, SnapshotNotFoundError: class extends Error {} }))
vi.mock('../services/pim/listing-alias.service.js', () => ({ createAlias: mocks.createAlias, updateAlias: mocks.updateAlias, archiveAlias: mocks.archiveAlias, AliasCreationBlockedError: class extends Error {}, AliasNotFoundError: class extends Error {}, AliasScopeMismatchError: class extends Error { code = 'LISTING_SCOPE_MISMATCH' } }))
import routes from './product-studio.routes.js'
import { AmbiguousConnectionError, NoConnectionError } from '../services/connection-resolver.service.js'
import { AliasScopeMismatchError } from '../services/pim/listing-alias.service.js'
import { COMMAND_SCOPE_ROUTES } from '../lib/command-idempotency.js'

let app: FastifyInstance
beforeAll(async () => { app = Fastify(); await app.register(multipart); await app.register(routes); await app.ready() })
afterAll(() => app.close())
beforeEach(() => {
  vi.clearAllMocks()
  mocks.sheet.mockImplementation(async ({ accountId }) => ({ scope: { connectionId: accountId }, family: {}, columns: [], groups: [], rows: [], meta: { tookMs: 1 } }))
  mocks.readiness.mockResolvedValue({ scopes: [] })
  mocks.computeDiff.mockResolvedValue({ cells: [], counts: {}, unknownColumns: [] })
  mocks.storePreview.mockResolvedValue({ jobId: 'review', expiresAt: new Date('2099-01-01') })
})

describe('legacy Studio imports cannot infer channel accounts', () => {
  const upload = (scope: string, csv: string) => {
    const boundary = 'studio-import-test'
    const fields = { scope, market: 'IT', ...(scope === 'channel' ? { channel: 'EBAY' } : {}) }
    const parts = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="table.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`)
    return app.inject({ method: 'POST', url: '/products/p/import/diff', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: parts.join('') })
  }
  it.each([
    ['channel', 'sku,name\nP,Title'],
    ['master', 'sku,name@EBAY:IT:it\nP,Title'],
    ['master', 'SKU,Title\nsku,name@AMAZON:IT:it\nP,Title'],
  ])('refuses account-less destinations before staging: %s / %s', async (scope, csv) => {
    const result = await upload(scope, csv)
    expect(result.statusCode).toBe(409)
    expect(result.json().error).toBe('account_identity_required')
    expect(mocks.computeDiff).not.toHaveBeenCalled()
    expect(mocks.storePreview).not.toHaveBeenCalled()
  })
  it('preserves shared-only file review', async () => {
    const result = await upload('master', 'sku,name\nP,Shared title')
    expect(result.statusCode, result.body).toBe(200)
    expect(mocks.computeDiff).toHaveBeenCalledWith(expect.objectContaining({ headerRow: ['sku', 'name'] }))
    expect(mocks.storePreview).toHaveBeenCalledOnce()
  })
  it.each(['apply', 'revert'])('refuses historical channel %s even under a stored shared scope', async action => {
    mocks.readJob.mockResolvedValue({ scope: { kind: 'master' }, market: 'IT', cells: [{ scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT' } }] })
    const result = await app.inject({ method: 'POST', url: `/products/p/import/jobs/legacy/${action}` })
    expect(result.statusCode).toBe(409)
    expect(result.json().error).toBe('account_identity_required')
    expect(mocks.applyJob).not.toHaveBeenCalled()
    expect(mocks.revertJob).not.toHaveBeenCalled()
  })
})

describe('Studio account coordinates', () => {
  it.each(['account-a', 'account-b'])('uses the same account for category-specific columns and rows: %s', async accountId => {
    const query = `scope=channel&channel=EBAY&market=IT&accountId=${accountId}`
    const columns = await app.inject(`/products/p/studio/columns?${query}`)
    const rows = await app.inject(`/products/p/studio/sheet?${query}`)
    expect(columns.statusCode).toBe(200)
    expect(rows.statusCode).toBe(200)
    expect(columns.json().scope).toEqual({ connectionId: accountId })
    expect(rows.json().scope).toEqual(columns.json().scope)
    expect(mocks.sheet.mock.calls.every(([input]) => input.accountId === accountId)).toBe(true)
  })

  it.each([
    [new NoConnectionError('Account is inactive'), 400],
    [new AmbiguousConnectionError('EBAY', ['a', 'b']), 409],
  ])('reports account refusal as an actionable client response', async (error, status) => {
    mocks.sheet.mockRejectedValue(error)
    for (const route of ['columns', 'sheet']) {
      const result = await app.inject(`/products/p/studio/${route}?scope=channel&channel=EBAY&market=IT&accountId=b`)
      expect(result.statusCode).toBe(status)
      expect(result.json()).toMatchObject({ error: (error as Error & { code: string }).code, message: (error as Error).message })
    }
  })

  it('carries the selected account into readiness and refuses an account without a channel', async () => {
    expect((await app.inject('/products/p/readiness?market=IT&channel=EBAY&accountId=b')).statusCode).toBe(200)
    expect(mocks.readiness).toHaveBeenCalledWith({ productId: 'p', market: 'IT', channel: 'EBAY', accountId: 'b' })
    mocks.readiness.mockClear()
    expect((await app.inject('/products/p/readiness?market=IT&accountId=b')).statusCode).toBe(400)
    expect(mocks.readiness).not.toHaveBeenCalled()
  })

  it('preserves the product and named account through alias lifecycle requests', async () => {
    await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'EBAY', marketplace: 'IT', accountId: 'b', label: 'Italy' } })
    expect(mocks.createAlias).toHaveBeenCalledWith(expect.objectContaining({ productId: 'p', accountId: 'b', channel: 'EBAY', marketplace: 'IT' }))
    await app.inject({ method: 'PATCH', url: '/products/p/aliases/alias-b', payload: { accountId: 'b', label: 'Italy' } })
    expect(mocks.updateAlias).toHaveBeenCalledWith('alias-b', { label: 'Italy', position: undefined }, { productId: 'p', accountId: 'b' })
    await app.inject({ method: 'DELETE', url: '/products/p/aliases/alias-b?accountId=b' })
    expect(mocks.archiveAlias).toHaveBeenCalledWith('alias-b', { productId: 'p', accountId: 'b' })
  })

  it('refuses an empty explicit alias account and returns scope mismatch as a conflict', async () => {
    const empty = await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'EBAY', marketplace: 'IT', accountId: '' } })
    expect(empty.statusCode).toBe(400)
    expect(mocks.createAlias).not.toHaveBeenCalled()
    mocks.updateAlias.mockRejectedValueOnce(new AliasScopeMismatchError())
    const stale = await app.inject({ method: 'PATCH', url: '/products/p/aliases/alias-b', payload: { accountId: 'a', label: 'Wrong account' } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('LISTING_SCOPE_MISMATCH')
  })
})

// Add rows R3 (2026-10-05) — the sheet's empty "Listing (alias)" row sends the SKU typed into it.
describe('a new listing alias from an empty sheet row', () => {
  it('passes the SKU through, as the new listing\'s channel SKU too', async () => {
    mocks.createAlias.mockResolvedValue({ id: 'alias-n', sku: 'IT-FAM-2' })
    const created = await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'ebay', marketplace: 'it', accountId: 'b', sku: 'IT-FAM-2' } })
    expect(created.statusCode).toBe(201)
    expect(mocks.createAlias).toHaveBeenCalledWith(expect.objectContaining({ productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'b', sku: 'IT-FAM-2', channelSku: true }))
  })
  it('creates a SKU-less alias as before when no SKU is sent (the ⋯ menu)', async () => {
    await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'EBAY', marketplace: 'IT', accountId: 'b' } })
    const input = mocks.createAlias.mock.calls[0][0]
    expect(input).not.toHaveProperty('sku')
    expect(input).not.toHaveProperty('channelSku')
  })
  it('refuses a SKU that is not text', async () => {
    const result = await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'EBAY', marketplace: 'IT', accountId: 'b', sku: 42 } })
    expect(result.statusCode).toBe(400)
    expect(mocks.createAlias).not.toHaveBeenCalled()
  })
  it('answers a channel-SKU refusal with its status and its own sentence (the row shows it)', async () => {
    const refusal = Object.assign(new Error('TAKEN-1 is already the SKU of OTHER on this eBay account (eBay · IT). Within one channel account a SKU names one product: choose another SKU.'),
      { statusCode: 409, code: 'SKU_TAKEN' })
    mocks.createAlias.mockRejectedValueOnce(refusal)
    const result = await app.inject({ method: 'POST', url: '/products/p/aliases', payload: { channel: 'EBAY', marketplace: 'IT', accountId: 'b', sku: 'TAKEN-1' } })
    expect(result.statusCode).toBe(409)
    expect(result.json()).toEqual({ error: 'SKU_TAKEN', message: refusal.message })
  })
  it('keeps one variation or alias per typed SKU when the answer is lost and the row sends again (Idempotency-Key)', () => {
    expect(COMMAND_SCOPE_ROUTES).toEqual(expect.arrayContaining(['/api/products/:id/aliases', '/api/catalog/products/:parentId/children']))
  })
})
