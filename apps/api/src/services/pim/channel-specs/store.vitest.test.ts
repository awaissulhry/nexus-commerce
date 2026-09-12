import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ marketplace: { findMany: vi.fn() }, channelListing: { groupBy: vi.fn() } }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('../field-registry.service.js', () => ({ getAvailableFields: async () => [
  { id: 'sku', label: 'SKU', type: 'text', category: 'identity', editable: false },
  { id: 'name', label: 'Name', type: 'text', category: 'identity' },
] }))
import { clearSheetColumnCache, getSheetColumns } from '../sheet-columns.service.js'
import { resolveWriteRouting } from '../studio-sheet.service.js'
import { buildCoordinateValidators, evaluateRow } from '../readiness.service.js'
import { coerceForShape } from '../sheet-values.js'
import { channelValuePatch, storedChannelState } from '../channel-value-mutation.js'
import { etsyProductSpec, shopifyProductSpec } from './store.js'
import { attributesFromCells, validateSchemaAttributes } from '../mapping/schema-requirements.js'

beforeEach(() => {
  clearSheetColumnCache()
  db.marketplace.findMany.mockResolvedValue(['SHOPIFY', 'ETSY'].map(channel => ({ channel, code: 'GLOBAL', language: 'en', isActive: true })))
})
const sheet = (channel: 'SHOPIFY' | 'ETSY') => getSheetColumns({ market: 'GLOBAL', productTypes: [], onlyChannels: [channel], includeEmptyChannels: true, scopeKind: 'channel' })

describe('store product information contracts', () => {
  it.each(['SHOPIFY', 'ETSY'] as const)('opens %s without an Amazon marketplace or product type', async channel => {
    const result = await sheet(channel)
    expect(result.coordinates).toEqual([expect.objectContaining({ channel, marketplace: 'GLOBAL' })])
    expect(result.columns.map(c => c.key)).toEqual(expect.arrayContaining(['name', 'description', channel === 'ETSY' ? 'keywords' : 'tags']))
    expect(result.columns.some(c => ['amazonAsin', 'bulletPoints', 'fulfillmentChannel', 'productType'].includes(c.key))).toBe(false)
    for (const c of result.columns.filter(c => c.editable)) expect(resolveWriteRouting(c, { channel }, null)).toMatchObject({
      writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false, writeField: expect.stringMatching(/^attr_/) })
    const validators = buildCoordinateValidators(result.columns, result.coordinates[0], { isParent: false, productType: null })
    expect(evaluateRow({}, validators).some(i => i.message.includes('no channel schema'))).toBe(false)
  })
  it('keeps Etsy limits out of Shopify and accepts the current era values', async () => {
    const etsy = await sheet('ETSY'), shopify = await sheet('SHOPIFY')
    const tag = etsy.columns.find(c => c.key === 'keywords')!
    expect(coerceForShape(tag, Array.from({ length: 14 }, (_, n) => `tag ${n}`)).ok).toBe(false)
    expect(coerceForShape(tag, ['a'.repeat(21)]).ok).toBe(false)
    expect(coerceForShape(tag, ['leather', 'leather']).ok).toBe(false)
    expect(coerceForShape(tag, ['leather & steel']).ok).toBe(false)
    expect(coerceForShape(tag, ['café', 'hand-made']).ok).toBe(true)
    expect(coerceForShape(shopify.columns.find(c => c.key === 'tags'), ['a'.repeat(21)]).ok).toBe(true)
    expect(coerceForShape(etsy.columns.find(c => c.key === 'when_made'), '2020_2026').ok).toBe(true)
    expect(coerceForShape(etsy.columns.find(c => c.key === 'when_made'), '2020_2025').ok).toBe(false)
    expect(coerceForShape(etsy.columns.find(c => c.key === 'name'), 'A & B & C').ok).toBe(false)
    expect(coerceForShape(etsy.columns.find(c => c.key === 'name'), 'a'.repeat(141)).ok).toBe(false)
    expect(coerceForShape(etsy.columns.find(c => c.key === 'taxonomy_id'), 1.5).ok).toBe(false)
  })
  it.each([shopifyProductSpec, etsyProductSpec])('round-trips explicit clears, false and nested values without changing unrelated attributes', createSpec => {
    const s = createSpec()
    const title = s.fields.find(f => f.key === 'title')!
    const initial = { title: 'Remote title', titleOverride: 'Local title', followMasterTitle: false, overrideData: {}, platformAttributes: { untouched: 'keep' } }
    const cleared = { ...initial, ...channelValuePatch(initial, title.channelStore, ['name', 'title'], 'CLEAR') }
    expect(cleared).toMatchObject({ titleOverride: null, followMasterTitle: false })
    expect(storedChannelState(cleared, title.channelStore, ['name', 'title'])).toEqual({ state: 'stored', value: null })
    const inherited = { ...cleared, ...channelValuePatch(cleared, title.channelStore, ['name', 'title'], 'INHERIT') }
    expect(storedChannelState(inherited, title.channelStore, ['name', 'title']).state).toBe('inherited')
    const f = s.fields.find(f => f.key === (s.channel === 'SHOPIFY' ? 'seo_title' : 'is_supply'))!
    const value = s.channel === 'SHOPIFY' ? 'Search title' : false
    const changed = { ...initial, ...channelValuePatch(initial, f.channelStore, [f.key], 'SET', value) }
    expect(storedChannelState(changed, f.channelStore, [f.key]).value).toBe(value)
    expect(changed.platformAttributes.untouched).toBe('keep')
  })
  it('gives the mapping resolver the same Etsy constraints as the sheet', () => {
    const s = etsyProductSpec()
    const values = { title: 'Leather bag', description: 'Handmade bag', price: 20, quantity: 0, taxonomy_id: 1, who_made: 'i_did', when_made: 'made_to_order', is_supply: false }
    expect(validateSchemaAttributes(s, attributesFromCells(s, values))).toEqual([])
    expect(validateSchemaAttributes(s, attributesFromCells(s, { ...values, tags: ['a'.repeat(21)] }))).not.toEqual([])
  })
})
