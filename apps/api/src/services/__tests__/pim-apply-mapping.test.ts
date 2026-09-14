/**
 * FM.6 — apply engine verifier.
 *
 * Pure helpers (translatableTarget / toAuditString / payloadValueFor) +
 * a mocked-orchestration test: translate needed languages, save translated
 * drafts through the common content writer, enqueue one push per coordinate
 * (price fields skipped), audit. prisma / translate / queue / planner are
 * mocked so the suite stays pure/fast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockPrisma, txMock, mockPlan, mockTranslate, mockQueueAdd } = vi.hoisted(() => {
  const txMock = {
    product: { findUnique: vi.fn(), update: vi.fn() },
    productTranslation: { upsert: vi.fn() },
    channelListingOverride: { create: vi.fn() },
    outboundSyncQueue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    channelListing: { update: vi.fn() },
  }
  return {
    txMock,
    mockPrisma: {
      product: { findUnique: vi.fn() },
      channelListing: { findMany: vi.fn() },
      terminologyPreference: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: any) => fn(txMock)),
    },
    mockPlan: vi.fn(),
    mockTranslate: vi.fn(),
    mockQueueAdd: vi.fn(),
  }
})

vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  return { default: contextualDatabase(mockPrisma as never) }
})
const mockWriteTranslation = vi.fn(async () => ({}))
vi.mock('../pim/translation-write.js', () => ({ writeTranslation: (...args: unknown[]) => mockWriteTranslation(...args) }))
vi.mock('../pim/mapping-propagation.service.js', () => ({ planMappingPropagation: mockPlan }))
vi.mock('../ai/translate.service.js', () => ({ translateProductCopy: mockTranslate }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: { add: mockQueueAdd } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import { applyCatalogCascade, translatableTarget, toAuditString, payloadValueFor } from '../pim/apply-mapping.service.js'

const flags = (over: Partial<Record<string, boolean>> = {}) => ({
  transformed: false,
  needsTranslation: false,
  channelLimitTrimmed: false,
  currencyMismatch: false,
  unmappedRequired: false,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  txMock.product.findUnique.mockResolvedValue({ localizedContent: {} })
  txMock.outboundSyncQueue.findFirst.mockResolvedValue(null)
  txMock.outboundSyncQueue.create.mockResolvedValue({ id: 'q1' })
})

// ════════════════════════════════════════════════════════════════════
// pure helpers
// ════════════════════════════════════════════════════════════════════
describe('translatableTarget', () => {
  it('maps title aliases → title/name, description aliases → description/description, else null', () => {
    expect(translatableTarget('item_name')).toEqual({ localized: 'title', pt: 'name' })
    expect(translatableTarget('title')).toEqual({ localized: 'title', pt: 'name' })
    expect(translatableTarget('product_description')).toEqual({ localized: 'description', pt: 'description' })
    expect(translatableTarget('material_type')).toBeNull()
  })
})

describe('toAuditString', () => {
  it('serializes values to a string or null', () => {
    expect(toAuditString(null)).toBeNull()
    expect(toAuditString(undefined)).toBeNull()
    expect(toAuditString('x')).toBe('x')
    expect(toAuditString(5)).toBe('5')
    expect(toAuditString(true)).toBe('true')
    expect(toAuditString(['a', 'b'])).toBe('["a","b"]')
  })
})

describe('payloadValueFor', () => {
  it('uses the translated value for a cross-language translatable entry', () => {
    const entry = { channel: 'AMAZON', marketplace: 'DE', fieldKey: 'item_name', current: 'x', proposed: 'Giacca', action: 'update' as const, language: 'de', flags: flags({ needsTranslation: true }) }
    expect(payloadValueFor(entry, { de: { title: 'Jacke' } })).toBe('Jacke')
  })
  it('blocks the payload when a required translation is unavailable', () => {
    const entry = { channel: 'AMAZON', marketplace: 'DE', fieldKey: 'item_name', current: 'x', proposed: 'Giacca', action: 'update' as const, language: 'de', flags: flags({ needsTranslation: true }) }
    expect(() => payloadValueFor(entry, {})).toThrow('Translation is pending')
  })
  it('uses proposed for a non-translation entry', () => {
    const entry = { channel: 'AMAZON', marketplace: 'IT', fieldKey: 'material_type', current: 'x', proposed: 'Pelle', action: 'update' as const, language: 'it', flags: flags() }
    expect(payloadValueFor(entry, { it: { title: 'ignored' } })).toBe('Pelle')
  })
})

// ════════════════════════════════════════════════════════════════════
// orchestration (mocked)
// ════════════════════════════════════════════════════════════════════
describe('applyCatalogCascade', () => {
  beforeEach(() => {
    mockPlan.mockResolvedValue({
      productId: 'p1',
      sku: 'SKU1',
      changedAttributes: ['title'],
      entries: [
        { channel: 'AMAZON', marketplace: 'DE', fieldKey: 'item_name', current: 'Alt', proposed: 'Giacca', action: 'update', language: 'de', flags: flags({ needsTranslation: true }) },
        { channel: 'AMAZON', marketplace: 'IT', fieldKey: 'item_name', current: 'Giacca', proposed: 'Giacca', action: 'update', language: 'it', flags: flags() },
        { channel: 'AMAZON', marketplace: 'UK', fieldKey: 'our_price', current: 100, proposed: 120, action: 'skip', language: 'en', flags: flags({ currencyMismatch: true }) },
      ],
      counts: { total: 3, willUpdate: 2, needsReview: 1, skipped: 1, currencyMismatch: 1, unmappedRequired: 0 },
    })
    mockPrisma.product.findUnique.mockResolvedValue({ brand: 'XAVIA' })
    mockPrisma.terminologyPreference.findMany.mockResolvedValue([])
    mockPrisma.channelListing.findMany.mockResolvedValue([
      { id: 'cl_de', channel: 'AMAZON', marketplace: 'DE', region: 'DE', externalListingId: 'ASIN_DE' },
      { id: 'cl_it', channel: 'AMAZON', marketplace: 'IT', region: 'IT', externalListingId: 'ASIN_IT' },
      { id: 'cl_uk', channel: 'AMAZON', marketplace: 'UK', region: 'UK', externalListingId: 'ASIN_UK' },
    ])
    mockTranslate.mockResolvedValue({ name: 'Jacke', description: null, source: 'ai-gemini', sourceModel: 'gemini-2.0-flash' })
  })

  it('translates only the needed language with the changed source text', async () => {
    await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } })
    expect(mockTranslate).toHaveBeenCalledTimes(1)
    expect(mockTranslate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'de', source: { name: 'Giacca' } }))
  })

  it('stores translated content through the common writer as an unreviewed language draft', async () => {
    await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } })
    expect(mockWriteTranslation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      productId: 'p1', locale: 'de', address: { tier: 'language', language: 'de' }, state: 'draft',
      values: expect.objectContaining({ title: 'Jacke' }),
    }))
    expect(txMock.product.update).not.toHaveBeenCalled()
  })

  it('queues reviewed source content while withholding translated drafts and price fields', async () => {
    const result = await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } })
    expect(result.queuedCoordinates).toBe(1) // IT only; DE is an unreviewed draft.
    expect(result.skippedPriceFields).toBe(1)
    expect(result.translatedLanguages).toEqual(['de'])
    // Translation drafts must be reviewed before they can enter a channel queue.
    const createPayloads = txMock.outboundSyncQueue.create.mock.calls.map((c) => c[0].data.payload)
    const de = createPayloads.find((p: any) => p.marketplace === 'DE')
    const it = createPayloads.find((p: any) => p.marketplace === 'IT')
    expect(de).toBeUndefined()
    expect(it.fields.item_name).toBe('Giacca')
  })

  it('rides the holdUntil grace window and enqueues BullMQ after commit', async () => {
    await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } })
    const created = txMock.outboundSyncQueue.create.mock.calls[0][0].data
    expect(created.holdUntil).toBeInstanceOf(Date)
    expect(created.syncType).toBe('ATTRIBUTE_UPDATE')
    expect(mockQueueAdd).toHaveBeenCalledTimes(1)
  })

  it('applyGrace=false → no hold window', async () => {
    await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } }, { applyGrace: false })
    const created = txMock.outboundSyncQueue.create.mock.calls[0][0].data
    expect(created.holdUntil).toBeNull()
  })
  it('does not collapse different accounts and aliases on the same market', async () => {
    const listings = [
      { id: 'a', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-a', aliasKey: '' },
      { id: 'b', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'outlet' },
    ]
    mockPrisma.channelListing.findMany.mockResolvedValue(listings)
    mockPlan.mockResolvedValue({ productId: 'p1', sku: 'SKU1', entries: listings.map(l => ({ ...l, listingId: l.id, fieldKey: 'color', current: l.id, proposed: l.id, action: 'update', language: 'it', flags: flags() })) })
    await applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { color: 'new' } })
    expect(txMock.outboundSyncQueue.create.mock.calls.map(([q]) => [q.data.channelListingId, q.data.payload.channelConnectionId, q.data.payload.aliasKey, q.data.payload.fields.color])).toEqual([
      ['a', 'account-a', '', 'a'], ['b', 'account-b', 'outlet', 'b'],
    ])
  })
  it('rejects an ambiguous account before entering the write transaction', async () => {
    mockPlan.mockResolvedValue({ productId: 'p1', sku: 'SKU1', entries: [{ channel: 'EBAY', marketplace: 'IT', fieldKey: 'color', current: 'red', proposed: 'red', action: 'update', flags: flags() }] })
    mockPrisma.channelListing.findMany.mockResolvedValue(['a', 'b'].map(id => ({ id, channel: 'EBAY', marketplace: 'IT', channelConnectionId: id, aliasKey: '' })))
    await expect(applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { color: 'red' } })).rejects.toThrow('exact listing')
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })
  it('writes nothing when translation fails', async () => {
    mockTranslate.mockRejectedValue(new Error('translator unavailable'))
    await expect(applyCatalogCascade({ contentAddress: { tier: 'source' }, productId: 'p1', changes: { title: 'Giacca' } })).rejects.toThrow('Translation is pending')
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })
})
