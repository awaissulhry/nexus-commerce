/**
 * B.1 — mapping-matrix pivot verifier (pure pivotMatrix). prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ product: { findUnique: vi.fn() }, channelListing: { findMany: vi.fn() }, resolve: vi.fn() }))
vi.mock('../../db.js', () => ({ default: mocks }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: mocks.resolve }))

import { pivotMatrix, buildMappingMatrix } from '../pim/mapping-matrix.service.js'

it('resolves each listing once and loads a baseline only for mapped overrides', async () => {
  mocks.product.findUnique.mockResolvedValue({ id: 'p1', sku: 'SKU' })
  mocks.channelListing.findMany.mockResolvedValue(['a', 'b'].map(id => ({ id, channel: 'EBAY', marketplace: 'IT', channelConnectionId: id, aliasKey: id === 'b' ? 'outlet' : '', version: 3 })))
  mocks.resolve.mockImplementation(async input => ({ channel: input.channel, marketplace: input.marketplace, catalogue: { fields: [{ fieldKey: 'colour', label: 'Colour' }] },
    products: [{ productId: 'p1', sku: 'SKU', category: { channelCategoryId: '123' }, cells: { colour: {
      fieldKey: 'colour', value: input.channelConnectionId === 'b' && !input.inheritMappedFields ? 'Red' : 'Blue',
      provenance: input.channelConnectionId === 'b' && !input.inheritMappedFields ? 'override' : 'catalogRule', rule: { source: 'color' }, warnings: [], errors: [], appliedTransforms: [],
    } } }] }))
  const result = await buildMappingMatrix({ productId: 'p1' })
  expect(mocks.resolve).toHaveBeenCalledTimes(3)
  expect(mocks.resolve.mock.calls.filter(([input]) => input.inheritMappedFields).map(([input]) => [input.channelConnectionId, input.aliasKey])).toEqual([['b', 'outlet']])
  expect(result.fields[0]).toMatchObject({ label: 'Colour', cells: { a: { value: 'Blue', diverges: false }, b: { value: 'Red', masterValue: 'Blue', diverges: true } } })
})

function field(fieldKey: string, value: unknown, opts: Record<string, unknown> = {}) {
  return {
    fieldKey,
    rule: { source: 'x' },
    value,
    source: 'source',
    raw: value,
    appliedTransforms: [],
    warnings: [],
    required: false,
    ...opts,
  } as any
}
function preview(channel: string, marketplace: string, fields: any[], missingRequired: string[] = []) {
  return { productId: 'p1', productSku: 'SKU', channel, marketplace, payload: {}, fields, missingRequired } as any
}
const coord = (channel: string, marketplace: string, isPublished = true) => ({
  channel,
  marketplace,
  hasListing: true,
  isPublished,
})

describe('pivotMatrix', () => {
  it('pivots fields × coordinates into cells', () => {
    const coordinates = [coord('AMAZON', 'IT'), coord('AMAZON', 'DE', false)]
    const previews = [
      preview('AMAZON', 'IT', [field('item_name', 'Giacca'), field('material_type', 'Pelle')]),
      preview('AMAZON', 'DE', [field('item_name', 'Jacke')]),
    ]
    const { fields } = pivotMatrix({ coordinates, previews, divergences: [] })
    const itemName = fields.find((f) => f.fieldKey === 'item_name')!
    expect(Object.keys(itemName.cells)).toEqual(['AMAZON:IT', 'AMAZON:DE'])
    expect(itemName.cells['AMAZON:IT'].value).toBe('Giacca')
    expect(itemName.cells['AMAZON:DE'].value).toBe('Jacke')
    const material = fields.find((f) => f.fieldKey === 'material_type')!
    expect(Object.keys(material.cells)).toEqual(['AMAZON:IT']) // only IT mapped it
  })

  it('flags divergent cells + sets the row master from the divergence entry', () => {
    const coordinates = [coord('AMAZON', 'IT')]
    const previews = [preview('AMAZON', 'IT', [field('colour', 'Rosso', { provenance: 'override' })])]
    const divergences = [
      { channel: 'AMAZON', marketplace: 'IT', fieldKey: 'colour', overrideValue: 'Rosso', masterValue: 'Rosso Lucido' },
    ]
    const { fields, divergent } = pivotMatrix({ coordinates, previews, divergences })
    expect(fields[0].cells['AMAZON:IT'].diverges).toBe(true)
    expect(fields[0].master).toBe('Rosso Lucido')
    expect(divergent).toBe(1)
  })

  it('counts missingRequired + skips null previews', () => {
    const coordinates = [coord('AMAZON', 'IT'), coord('EBAY', 'IT', false)]
    const previews = [
      preview('AMAZON', 'IT', [field('item_name', null, { required: true })], ['item_name']),
      null,
    ]
    const { fields, missingRequired } = pivotMatrix({ coordinates, previews, divergences: [] })
    expect(missingRequired).toBe(1)
    expect(fields[0].cells['AMAZON:IT'].missingRequired).toBe(true)
    expect(fields[0].cells['EBAY:IT']).toBeUndefined()
  })

  it('non-diverging row master falls back to the first cell value', () => {
    const coordinates = [coord('AMAZON', 'IT')]
    const previews = [preview('AMAZON', 'IT', [field('brand', 'XAVIA', { provenance: 'catalogRule' })])]
    const { fields } = pivotMatrix({ coordinates, previews, divergences: [] })
    expect(fields[0].master).toBe('XAVIA')
  })
})
