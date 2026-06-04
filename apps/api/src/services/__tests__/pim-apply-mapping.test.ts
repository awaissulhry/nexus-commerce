/**
 * FM.6 — apply engine verifier.
 *
 * Pure helpers (translatableTarget / toAuditString / payloadValueFor) +
 * a mocked-orchestration test: translate needed languages, write BOTH
 * localizedContent and ProductTranslation, enqueue one push per coordinate
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

vi.mock('../../db.js', () => ({ default: mockPrisma }))
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
  it('falls back to proposed when no translation is available', () => {
    const entry = { channel: 'AMAZON', marketplace: 'DE', fieldKey: 'item_name', current: 'x', proposed: 'Giacca', action: 'update' as const, language: 'de', flags: flags({ needsTranslation: true }) }
    expect(payloadValueFor(entry, {})).toBe('Giacca')
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
        { channel: 'AMAZON', marketplace: 'IT', fieldKey: 'item_name', current: 'Vecchio', proposed: 'Giacca', action: 'update', language: 'it', flags: flags() },
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
    await applyCatalogCascade({ productId: 'p1', changes: { title: 'Giacca' } })
    expect(mockTranslate).toHaveBeenCalledTimes(1)
    expect(mockTranslate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'de', source: { name: 'Giacca' } }))
  })

  it('writes BOTH localizedContent and ProductTranslation for the translated language', async () => {
    await applyCatalogCascade({ productId: 'p1', changes: { title: 'Giacca' } })
    expect(txMock.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ localizedContent: { de: { title: 'Jacke' } } }) }),
    )
    expect(txMock.productTranslation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId_language: { productId: 'p1', language: 'de' } },
        create: expect.objectContaining({ name: 'Jacke', reviewedAt: null }),
      }),
    )
  })

  it('enqueues one push per content coordinate, skips the price field', async () => {
    const result = await applyCatalogCascade({ productId: 'p1', changes: { title: 'Giacca' } })
    expect(result.queuedCoordinates).toBe(2) // DE + IT; UK price skipped
    expect(result.skippedPriceFields).toBe(1)
    expect(result.translatedLanguages).toEqual(['de'])
    // DE push carries the translated value; IT carries the proposed source value.
    const createPayloads = txMock.outboundSyncQueue.create.mock.calls.map((c) => c[0].data.payload)
    const de = createPayloads.find((p: any) => p.marketplace === 'DE')
    const it = createPayloads.find((p: any) => p.marketplace === 'IT')
    expect(de.fields.item_name).toBe('Jacke')
    expect(it.fields.item_name).toBe('Giacca')
  })

  it('rides the holdUntil grace window and enqueues BullMQ after commit', async () => {
    await applyCatalogCascade({ productId: 'p1', changes: { title: 'Giacca' } })
    const created = txMock.outboundSyncQueue.create.mock.calls[0][0].data
    expect(created.holdUntil).toBeInstanceOf(Date)
    expect(created.syncType).toBe('ATTRIBUTE_UPDATE')
    expect(mockQueueAdd).toHaveBeenCalledTimes(2)
  })

  it('applyGrace=false → no hold window', async () => {
    await applyCatalogCascade({ productId: 'p1', changes: { title: 'Giacca' } }, { applyGrace: false })
    const created = txMock.outboundSyncQueue.create.mock.calls[0][0].data
    expect(created.holdUntil).toBeNull()
  })
})
