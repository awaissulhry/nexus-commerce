import { describe, expect, it } from 'vitest'
import { compareAmazonAttributes, compareAmazonContent, normaliseText } from './amazon-content-compare.js'

/**
 * PLAN A-39 (R-41) — the compare rules, pure. Ours is the shape `buildAmazonContentEntries` emits; theirs the shape a
 * `getListingsItem` read returns.
 */
const DE = 'A1PA6795UKMFR9'
const entry = (value: string, tag = 'de_DE') => ({ value, marketplace_id: DE, language_tag: tag })
const content = (input: Record<string, unknown>, theirs: Record<string, unknown> | null, tags = ['de_DE']) =>
  compareAmazonContent(input as never, theirs, { marketplaceId: DE, tags })

describe('content', () => {
  it('identical text — spaces and a decomposed accent are not drift', () => {
    const r = content({ item_name: [entry('Giacca  Moto Gr\u00f6\u00dfe')] }, { item_name: [entry(' Giacca Moto Gro\u0308\u00dfe ')] })
    expect(r).toMatchObject({ compared: ['item_name[de_DE]'], differing: [] })
  })

  it('🔴 a seeded title difference → ONE entry, ours and theirs', () => {
    const r = content({ item_name: [entry('Motorradjacke Gale')] }, { item_name: [entry('Giacca moto Gale')] })
    expect(r.differing).toEqual([{ field: 'item_name[de_DE]', ours: 'Motorradjacke Gale', theirs: 'Giacca moto Gale' }])
  })

  it('🔴 our DE text missing → NOT compared (R-LX-6), and never drift', () => {
    const r = content({ item_name: [entry('Giacca', 'it_IT')] }, { item_name: [entry('Anders')] })
    expect(r.compared).toEqual([])
    expect(r.differing).toEqual([])
    expect(r.notCompared.find(n => n.field === 'item_name[de_DE]')?.reason).toMatch(/R-LX-6/)
  })

  it('ours present, Amazon absent → drift with theirs null', () => {
    expect(content({ generic_keyword: [entry('moto giacca')] }, { item_name: [entry('x')] }).differing)
      .toEqual([{ field: 'generic_keyword[de_DE]', ours: 'moto giacca', theirs: null }])
  })

  it('a tag only Amazon holds is ignored', () => {
    const r = content({ item_name: [entry('Jacke')] }, { item_name: [entry('Jacke'), entry('Jacket', 'en_GB')] })
    expect(r).toMatchObject({ compared: ['item_name[de_DE]'], differing: [] })
    expect(r.compared.some(f => f.includes('en_GB'))).toBe(false)
  })

  it('bullets are an ORDERED list — the same bullets in another order differ', () => {
    const ours = { bullet_point: [entry('A'), entry('B')] }
    expect(content(ours, { bullet_point: [entry('A'), entry('B')] }).differing).toEqual([])
    expect(content(ours, { bullet_point: [entry('B'), entry('A')] }).differing).toHaveLength(1)
  })

  it('the language tag is part of the key — an Italian entry does not satisfy the German one', () => {
    const r = content({ item_name: [entry('Jacke')] }, { item_name: [entry('Jacke', 'it_IT')] })
    expect(r.differing).toEqual([{ field: 'item_name[de_DE]', ours: 'Jacke', theirs: null }])
  })
})

describe('attributes', () => {
  it('key order does not matter; an Amazon-only leaf is ignored', () => {
    const ours = { color: [{ value: 'Nero', marketplace_id: DE }] }
    const theirs = { color: [{ marketplace_id: DE, value: 'Nero', language_tag: 'de_DE' }] }
    expect(compareAmazonAttributes(ours, theirs)).toMatchObject({ compared: ['color'], differing: [] })
  })

  it('a changed leaf → drift on that root, naming the leaf', () => {
    const r = compareAmazonAttributes({ color: [{ value: 'Nero', marketplace_id: DE }] }, { color: [{ value: 'Schwarz', marketplace_id: DE }] })
    expect(r.differing).toEqual([{ field: 'color', ours: { '[0].value': 'Nero' }, theirs: { '[0].value': 'Schwarz' } }])
  })

  it('a numeric text compares as a number', () => {
    expect(compareAmazonAttributes({ item_weight: [{ value: '1.50' }] }, { item_weight: [{ value: 1.5 }] }).differing).toEqual([])
  })

  it('content and structure roots are never compared as attributes', () => {
    const r = compareAmazonAttributes({ item_name: [{ value: 'x' }], variation_theme: [{ name: 'COLOR' }], child_parent_sku_relationship: [{ parent_sku: 'P' }] }, {})
    expect(r.compared).toEqual([])
  })

  it('a root we send that Amazon lacks → drift with theirs null', () => {
    expect(compareAmazonAttributes({ material: [{ value: 'Mesh' }] }, {}).differing).toEqual([{ field: 'material', ours: { '[0].value': 'Mesh' }, theirs: null }])
  })
})

it('normaliseText: NFC, whitespace, numbers', () => {
  expect(normaliseText('  a \n b ')).toBe('a b')
  expect(normaliseText('é')).toBe('é')
  expect(normaliseText('10.00')).toBe('10')
})
