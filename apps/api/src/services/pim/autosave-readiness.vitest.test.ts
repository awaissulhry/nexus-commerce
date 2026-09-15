import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, sheets: [] as Array<{ channel?: string; market: string; accountId?: string; locale?: string }> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('./studio-sheet.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./studio-sheet.service.js')>()
  return { ...actual, getStudioSheet: async (input: Parameters<typeof actual.getStudioSheet>[0]) => {
    state.sheets.push(input)
    return actual.getStudioSheet(input)
  } }
})
import prisma from '../../db.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'

beforeEach(() => { state.sheets.length = 0 })

beforeAll(async () => {
  await prisma.product.create({ data: { id: 'autosave-parent', sku: 'AUTOSAVE-PARENT', name: 'Parent', basePrice: 10, isParent: true, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'autosave-child', sku: 'AUTOSAVE-CHILD', name: 'Child', basePrice: 10, parentId: 'autosave-parent', status: 'DRAFT' } })
  for (const id of ['autosave-a', 'autosave-b']) await prisma.channelConnection.create({ data: { id, channelType: 'EBAY', isActive: true } as any })
  for (const [code, languages] of [['IT', ['it']], ['DE', ['de']], ['BE', ['nl', 'fr']]] as const) {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code, name: code, currency: 'EUR', region: 'EU', language: languages[0], languages: [...languages] } })
    for (const accountId of ['autosave-a', 'autosave-b']) for (const productId of ['autosave-parent', 'autosave-child']) {
      await prisma.channelListing.create({ data: { productId, channel: 'EBAY', channelMarket: `EBAY_${code}` as any,
        marketplace: code, region: 'EU', channelConnectionId: accountId, price: 10 } })
    }
  }
}, 30_000)

it('keeps shared edits broad and refuses an outdated listing version without overwriting stored values', async () => {
  state.sheets.length = 0
  const product = await prisma.product.findUniqueOrThrow({ where: { id: 'autosave-child' } })
  const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
  const result = await applyProductBulkEdits({ changes: [{ id: product.id, field: 'manufacturer', value: 'Shared manufacturer', target: 'master' }], expectedVersion: product.version }, context)
  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(state.sheets).toHaveLength(12)
  expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).manufacturer).toBe('Shared manufacturer')
  const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: product.id, marketplace: 'BE', channelConnectionId: 'autosave-a' } })
  await expect(applyProductBulkEdits({ changes: [{ id: product.id, field: 'ebay_price', value: 99, target: 'channel' }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'BE', accountId: 'autosave-a' }], expectedVersion: listing.version - 1 }, context)).rejects.toMatchObject({ statusCode: 409 })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ price: listing.price, version: listing.version })
}, 30_000)
afterAll(async () => { await state.db?.close() })

it('saves a listing in real PostgreSQL while recomputing only its destination’s languages and family', async () => {
  const start = performance.now()
  await reconcileFamilyReadiness('autosave-parent')
  const fullMs = performance.now() - start
  const fullSheets = state.sheets.length
  expect(fullSheets).toBe(12)
  const before = await prisma.readinessIndex.findMany({ orderBy: { id: 'asc' } })
  expect(before.some(row => row.accountId === 'autosave-b')).toBe(true)
  expect(before.some(row => row.channel === null)).toBe(true)
  state.sheets.length = 0
  const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: 'autosave-child', marketplace: 'BE', channelConnectionId: 'autosave-a' } })
  const savedAt = performance.now()
  const result = await applyProductBulkEdits({ changes: [{ id: 'autosave-child', field: 'ebay_price', value: 12, target: 'channel' }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'BE', accountId: 'autosave-a' }], expectedVersion: listing.version },
  { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }).catch(error => { throw new Error(JSON.stringify(error.details ?? error.message)) })
  const saveMs = performance.now() - savedAt
  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(state.sheets.map(({ channel, market, accountId, locale }) => ({ channel, market, accountId, locale }))).toEqual([
    { channel: 'EBAY', market: 'BE', accountId: 'autosave-a', locale: 'nl' },
    { channel: 'EBAY', market: 'BE', accountId: 'autosave-a', locale: 'fr' },
  ])
  const after = await prisma.readinessIndex.findMany({ orderBy: { id: 'asc' } })
  const unrelated = (rows: typeof after) => rows.filter(row => row.channel !== 'EBAY' || row.market !== 'BE' || row.accountId !== 'autosave-a')
  expect(unrelated(after)).toEqual(unrelated(before))
  expect(after.filter(row => row.market === 'BE' && row.accountId === 'autosave-a').map(row => row.productId).sort()).toEqual([
    'autosave-child', 'autosave-child', 'autosave-parent', 'autosave-parent',
  ])
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(12)
  expect(stored.version).toBeGreaterThan(listing.version)
  if (process.env.AUTOSAVE_PROFILE === '1') {
    const measurements: Array<{ fullMs: number; scopedMs: number }> = []
    for (let trial = 0; trial < 3; trial++) {
      const fullStart = performance.now()
      await reconcileFamilyReadiness('autosave-parent')
      const full = performance.now() - fullStart
      const scopedStart = performance.now()
      await reconcileFamilyReadiness('autosave-parent', { channel: 'EBAY', market: 'BE', accountId: 'autosave-a' })
      measurements.push({ fullMs: Math.round(full), scopedMs: Math.round(performance.now() - scopedStart) })
    }
    process.stdout.write(`${JSON.stringify({ fixture: 'disposable PostgreSQL, 2 rows, 2 accounts, 3 markets', fullSheets, scopedSheets: 2,
      initialFullReadinessMs: Math.round(fullMs), scopedSaveMs: Math.round(saveMs), measurements })}\n`)
  }
}, 30_000)
