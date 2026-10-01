import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'
import { activeDatabaseTransaction, inDatabaseReadTransaction } from '../lib/database-context.js'
import { requireWorkspace, withWorkspace } from '../lib/workspace-context.js'

const mocks = vi.hoisted(() => ({ themes: vi.fn(), categories: vi.fn(), sheet: vi.fn() }))
vi.mock('../db.js', () => ({ default: { ebayDescriptionTheme: { findMany: mocks.themes } } }))
vi.mock('../services/categories/reference-labels.service.js', () => ({ cachedCategoryLabelsMany: mocks.categories }))
vi.mock('../services/pim/information-sheet.js', () => ({ getInformationSheet: mocks.sheet }))
import routes from './product-studio.routes.js'

const fixture = () => ({ scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', connectionId: 'account-a' }, schema: { marketplace: 'IT', locale: 'it' },
  family: { id: 'family-a' }, columns: [{ key: 'categoryId' }, { key: 'descriptionThemeId' }], groups: [], aliases: [],
  rows: [{ id: 'row-a', values: { categoryId: { value: '123' }, descriptionThemeId: { value: 'theme-a' } } },
    { id: 'row-b', values: { categoryId: { value: '123' }, descriptionThemeId: { value: 'theme-b' } } }], meta: { tookMs: 5, schemaMissing: [] },
})
let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', (_request, _reply, done) => withWorkspace({ workspaceId: 'business-a', actorUserId: 'user-a', membershipId: null, roleKeys: [] }, done))
  await app.register(multipart); await app.register(routes); await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  mocks.sheet.mockReset().mockImplementation(async () => {
    const client = { $transaction: async (work: (tx: object) => unknown) => work({ $executeRaw: async () => 0 }) }
    return inDatabaseReadTransaction(client as never, async () => { expect(activeDatabaseTransaction()).toBeDefined(); return fixture() as never })
  })
  mocks.themes.mockReset().mockImplementation(async () => {
    expect(activeDatabaseTransaction()).toBeUndefined()
    expect(requireWorkspace().workspaceId).toBe('business-a')
    return [{ id: 'theme-a', name: 'First theme' }, { id: 'theme-b', name: 'Second theme' }]
  })
  mocks.categories.mockReset().mockImplementation(async () => {
    expect(activeDatabaseTransaction()).toBeUndefined()
    expect(requireWorkspace().workspaceId).toBe('business-a')
    return { categoryId: { '123': 'Category path' } }
  })
})
const url = '/products/family-a/studio/sheet?scope=channel&channel=EBAY&market=IT&accountId=account-a&locales=it,de'
const WIRE = { plain: '', compact: '&cells=compact', pooled: '&cells=compact&patches=pooled' } as const
it.each(['plain', 'compact', 'pooled'] as const)('hydrates combined Languages once, outside the read transaction and inside the business scope (%s wire)', async wire => {
  const response = await app.inject(url + WIRE[wire])
  expect(response.statusCode).toBe(200)
  expect(mocks.sheet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ locales: ['it', 'de'] }))
  expect(mocks.themes).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['theme-a', 'theme-b'] } }, select: { id: true, name: true } })
  expect(mocks.categories).toHaveBeenCalledExactlyOnceWith('EBAY', 'IT', ['123'])
  const body = decodeSheetCells(response.json())
  expect(body.rows).toEqual(fixture().rows)
  expect(body.meta.referenceNames).toMatchObject({ channel: 'EBAY', market: 'IT', lookups: [
    { field: 'descriptionThemeId', ids: ['theme-a', 'theme-b'], labels: { 'theme-a': 'First theme', 'theme-b': 'Second theme' } },
    { field: 'categoryId', ids: ['123'], labels: { '123': 'Category path' } },
  ] })
})
it('keeps the sheet and independent names when an optional source fails', async () => {
  mocks.themes.mockRejectedValue(new Error('Optional name query failed'))
  const response = await app.inject(url)
  expect(response.statusCode).toBe(200)
  expect(response.json().rows).toEqual(fixture().rows)
  expect(response.json().meta.referenceNames.lookups.map((lookup: { field: string }) => lookup.field)).toEqual(['categoryId'])
})
