import { beforeEach, expect, it, vi } from 'vitest'
import type { PublicationFacts } from './studio-publication-plan.js'

const m = vi.hoisted(() => ({ drift: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { channelDrift: { findMany: m.drift } } }))
import { readPublicationOverwrite } from './studio-publication-overwrite.js'

const oldRead = '2026-09-20T10:00:00.000Z'
const lastRead = '2026-09-25T08:00:00.000Z'
const source = 'amazon-content'
const field = (name = 'item_name', at = oldRead, from = source) => ({
  field: name, ours: 'Nexus at the read', theirs: 'Channel at the read', source: from, checkedAt: at,
})
const clock = (overrides: Record<string, unknown> = {}) => ({ at: lastRead, outcome: 'compared', differing: 0, ...overrides })
const facts = (channel = 'AMAZON') => ({
  scope: { channel, marketplace: 'DE', accountId: 'account-a', listingId: 'selected-parent' },
  destination: { aliasKey: 'selected-alias' },
  products: [{ id: 'parent', sku: 'PARENT', name: 'Current Nexus title' }, { id: 'child', sku: 'CHILD', name: 'Current child title' }],
  listings: [
    { id: 'selected-parent', productId: 'parent', externalListingId: 'remote-parent' },
    { id: 'selected-child', productId: 'child', externalListingId: 'remote-child' },
    { id: 'excluded-listing', productId: 'excluded', externalListingId: 'remote-excluded' },
  ],
}) as unknown as PublicationFacts
const row = (checkedBySource: unknown, driftedFields: unknown = []) => ({
  channelListingId: 'selected-parent', checkedBySource, driftedFields,
  // These any-source properties must never establish a content read.
  driftCount: 81, lastCheckedAt: new Date(lastRead),
})

beforeEach(() => { vi.clearAllMocks(); m.drift.mockResolvedValue([]) })

it('keeps every included product visible and reads only existing listing IDs in the selected coordinate', async () => {
  m.drift.mockResolvedValue([
    row({ [source]: clock({ differing: 1 }) }, [field()]),
    { ...row({ [source]: clock({ differing: 1 }) }, [field('foreign-alias')]), channelListingId: 'another-alias' },
    { ...row({ [source]: clock({ differing: 1 }) }, [field('excluded')]), channelListingId: 'excluded-listing' },
  ])
  const result = await readPublicationOverwrite(facts())
  expect(m.drift.mock.calls[0][0].where).toEqual({ channelListingId: { in: ['selected-parent', 'selected-child'] } })
  expect(result.requiresConfirmation).toBe(true)
  expect(result.products.map(p => [p.productId, p.sku, p.status])).toEqual([
    ['parent', 'PARENT', 'compared'], ['child', 'CHILD', 'not_read'],
  ])
  expect(result.products.flatMap(p => p.fields.map(f => f.field))).toEqual(['item_name'])
})

it('does not count eBay stock reads or the row timestamp/count as content evidence', async () => {
  m.drift.mockResolvedValue([row({ 'ebay-trading-getitem': clock({ differing: 81 }) }, [field('quantity:CHILD', lastRead, 'ebay-trading-getitem')])])
  const result = await readPublicationOverwrite(facts('EBAY'))
  expect(result.products[0]).toMatchObject({ status: 'not_read', checkedAt: null, differing: 0, notCompared: null, omittedDifferences: 0, fields: [] })
  // A positive control: the same eBay row gains genuine content evidence.
  m.drift.mockResolvedValue([row({ 'ebay-content': clock({ differing: 1 }) }, [field('Title', lastRead, 'ebay-content')])])
  expect((await readPublicationOverwrite(facts('EBAY'))).products[0]).toMatchObject({ status: 'compared', differing: 1, fields: [{ field: 'Title' }] })
})

it('shows stored Nexus/channel values and each observation date, never current Nexus values', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock({ differing: 2, notCompared: 38 }) }, [field('item_name'), field('brand', lastRead), field('quantity', lastRead, 'amazon-inventory')])])
  const product = (await readPublicationOverwrite(facts())).products[0]
  expect(product).toMatchObject({ status: 'compared', checkedAt: lastRead, differing: 2, notCompared: 38, omittedDifferences: 0 })
  expect(product.fields).toEqual([
    { field: 'item_name', nexusAtRead: 'Nexus at the read', channelAtRead: 'Channel at the read', checkedAt: oldRead },
    { field: 'brand', nexusAtRead: 'Nexus at the read', channelAtRead: 'Channel at the read', checkedAt: lastRead },
  ])
})

it('retains historical differences when a later content read could not compare', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock({ outcome: 'not_compared', reason: 'Content endpoint unavailable', differing: 1 }) }, [field()])])
  expect((await readPublicationOverwrite(facts())).products[0]).toMatchObject({
    status: 'not_compared', reason: 'Content endpoint unavailable', checkedAt: lastRead, differing: 1,
    fields: [{ field: 'item_name', checkedAt: oldRead }],
  })
})

it('reports source differences missing from capped or partial stored entries', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock({ differing: 63 }) }, [field('item_name'), field('brand')])])
  expect((await readPublicationOverwrite(facts())).products[0]).toMatchObject({ differing: 63, omittedDifferences: 61 })
  // An older or inconsistent counter cannot erase stored differing fields.
  m.drift.mockResolvedValue([row({ [source]: clock({ differing: 0 }) }, [field('item_name'), field('brand')])])
  expect((await readPublicationOverwrite(facts())).products[0]).toMatchObject({ differing: 2, omittedDifferences: 0 })
})

it('caps displayed fields while preserving the full source count', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock({ differing: 63 }) }, Array.from({ length: 63 }, (_, i) => field(`field-${i}`)))])
  const product = (await readPublicationOverwrite(facts())).products[0]
  expect(product.fields).toHaveLength(50)
  expect(product).toMatchObject({ differing: 63, omittedDifferences: 13 })
})

it.each([undefined, null, [], {}, { at: 'invalid', outcome: 'compared' }, { at: lastRead, outcome: 'unknown' }])(
  'does not manufacture a compared status from a missing or invalid source clock (%j)', async badClock => {
    m.drift.mockResolvedValue([row({ [source]: badClock }, [field()])])
    expect((await readPublicationOverwrite(facts())).products[0]).toMatchObject({ status: 'not_read', checkedAt: null, notCompared: null, differing: 1, fields: [{ checkedAt: oldRead }] })
  },
)

it('keeps invalid counters unknown and invalid historical entries visibly omitted', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock({ differing: -9, notCompared: '38' }) }, [field(), { ...field('brand'), checkedAt: 'invalid' }, null, { source: 'other' }])])
  expect((await readPublicationOverwrite(facts())).products[0]).toMatchObject({ differing: 2, notCompared: null, omittedDifferences: 1, fields: [{ field: 'item_name' }] })
})

it('recognizes a genuine zero-difference content comparison without calling unread products clean', async () => {
  m.drift.mockResolvedValue([row({ [source]: clock() })])
  const result = await readPublicationOverwrite(facts())
  expect(result.requiresConfirmation).toBe(true)
  expect(result.products[0]).toMatchObject({ status: 'compared', checkedAt: lastRead, differing: 0, notCompared: 0 })
  expect(result.products[1]).toMatchObject({ status: 'not_read', checkedAt: null, notCompared: null })
})

it('marks listings without a remote identifier new and never queries an all-new family', async () => {
  const input = facts()
  input.listings = input.listings.map(l => ({ ...l, externalListingId: null }))
  const result = await readPublicationOverwrite(input)
  expect(result.requiresConfirmation).toBe(false)
  expect(result.products.map(p => p.status)).toEqual(['new', 'new'])
  expect(m.drift).not.toHaveBeenCalled()
})

it('covers mixed existing and new products without querying a new listing or excluded product', async () => {
  const input = facts()
  input.listings = input.listings.filter(l => l.productId !== 'child')
  const result = await readPublicationOverwrite(input)
  expect(result.requiresConfirmation).toBe(true)
  expect(result.products.map(p => p.status)).toEqual(['not_read', 'new'])
  expect(m.drift.mock.calls[0][0].where).toEqual({ channelListingId: { in: ['selected-parent'] } })
})

it('reports Shopify content observations as unknown and does not query stock drift', async () => {
  const result = await readPublicationOverwrite(facts('SHOPIFY'))
  expect(result.requiresConfirmation).toBe(true)
  expect(result.products.every(p => p.status === 'not_read' && p.notCompared === null)).toBe(true)
  expect(m.drift).not.toHaveBeenCalled()
})

it('propagates a failed drift query so a failed read cannot become a clean publish review', async () => {
  m.drift.mockRejectedValue(new Error('drift read failed'))
  await expect(readPublicationOverwrite(facts())).rejects.toThrow('drift read failed')
})
