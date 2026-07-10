/**
 * MT.1 — union manifest merge. Pure, so the multi-product-type column merge
 * (applicable/required-per-type, enum union) is fully unit-testable.
 */
import { describe, it, expect } from 'vitest'
import { mergeManifestsIntoUnion } from './flat-file.service.js'
import type { FlatFileManifest } from './flat-file.service.js'

const col = (id: string, required: boolean, extra: Record<string, unknown> = {}) => ({
  id, fieldRef: id, labelEn: id, labelLocal: '', required, kind: 'text' as const, width: 100, ...extra,
})
const mk = (productType: string, columns: any[], extra: Partial<FlatFileManifest> = {}): FlatFileManifest => ({
  marketplace: 'IT', productType, variationThemes: [], fetchedAt: '', expandedFields: {},
  groups: [{ id: 'required', labelEn: 'Required', labelLocal: '', color: '#fff', columns }],
  ...extra,
})

describe('MT.1 — mergeManifestsIntoUnion', () => {
  const jacket = mk('JACKET', [
    col('item_sku', true),
    col('material', true, { kind: 'enum', options: ['leather', 'textile'] }),
  ], { variationThemes: ['SIZE'], expandedFields: { bullet_point_1: 'bullet_point' } })
  const pants = mk('PANTS', [
    col('item_sku', true),
    col('material', false, { kind: 'enum', options: ['textile', 'denim'] }),
    col('inseam', true, { kind: 'number' }),
  ], { variationThemes: ['SIZE', 'COLOR'] })

  const union = mergeManifestsIntoUnion([jacket, pants], ['JACKET', 'PANTS'])
  const byId = Object.fromEntries(union.groups.flatMap((g) => g.columns).map((c) => [c.id, c]))

  it('covers both product types', () => {
    expect(union.productTypes).toEqual(['JACKET', 'PANTS'])
    expect(union.productType).toBe('JACKET+PANTS')
  })
  it('merges columns by id (no duplicates, order preserved)', () => {
    expect(union.groups.flatMap((g) => g.columns).map((c) => c.id)).toEqual(['item_sku', 'material', 'inseam'])
  })
  it('tags applicable types: shared → both, type-specific → one', () => {
    expect(byId.item_sku.applicableProductTypes).toEqual(['JACKET', 'PANTS'])
    expect(byId.inseam.applicableProductTypes).toEqual(['PANTS'])
  })
  it('required-for is per-type; union required if ANY type requires', () => {
    expect(byId.material.requiredForProductTypes).toEqual(['JACKET']) // required only for jacket
    expect(byId.material.required).toBe(true)
    expect(byId.item_sku.requiredForProductTypes).toEqual(['JACKET', 'PANTS'])
    expect(byId.inseam.requiredForProductTypes).toEqual(['PANTS'])
  })
  it('unions enum options across types', () => {
    expect([...(byId.material.options as string[])].sort()).toEqual(['denim', 'leather', 'textile'])
  })
  it('unions variation themes + expandedFields', () => {
    expect([...union.variationThemes].sort()).toEqual(['COLOR', 'SIZE'])
    expect(union.expandedFields).toMatchObject({ bullet_point_1: 'bullet_point' })
  })
  it('single type → still a valid union (everything tagged to that one type)', () => {
    const solo = mergeManifestsIntoUnion([jacket], ['JACKET'])
    expect(solo.productTypes).toEqual(['JACKET'])
    expect(solo.groups[0].columns[0].applicableProductTypes).toEqual(['JACKET'])
  })
})

describe('UFX P1 — union merge carries per-type enum sets + required-if-present/conditional flags', () => {
  const jacket = mk('JACKET', [
    col('material', false, { kind: 'enum', options: ['', 'Leather', 'Textile'], optionCodes: ['leather', 'textile'] }),
    col('item_weight__unit', false, { requiredWithParent: true }),
    col('num_batteries', false),
  ])
  const pants = mk('PANTS', [
    col('material', false, { kind: 'enum', options: ['', 'Denim'], optionCodes: ['denim'] }),
    col('item_weight__unit', false), // NOT required-if-present for pants
    col('num_batteries', false, { conditional: true }),
  ])
  const union = mergeManifestsIntoUnion([jacket, pants], ['JACKET', 'PANTS'])
  const byId = Object.fromEntries(union.groups.flatMap((g) => g.columns).map((c) => [c.id, c]))

  it('optionsByProductType keeps each type’s OWN labels (blank stripped)', () => {
    expect(byId.material.optionsByProductType).toEqual({ JACKET: ['Leather', 'Textile'], PANTS: ['Denim'] })
  })
  it('optionCodesByProductType keeps each type’s OWN codes; union optionCodes is the superset', () => {
    expect(byId.material.optionCodesByProductType).toEqual({ JACKET: ['leather', 'textile'], PANTS: ['denim'] })
    expect([...byId.material.optionCodes!].sort()).toEqual(['denim', 'leather', 'textile'])
  })
  it('requiredWithParent is per-type (JACKET only) with the union flag ORed', () => {
    expect(byId.item_weight__unit.requiredWithParent).toBe(true)
    expect(byId.item_weight__unit.requiredWithParentForProductTypes).toEqual(['JACKET'])
  })
  it('conditional ORs across types even when the FIRST manifest lacks it', () => {
    expect(byId.num_batteries.conditional).toBe(true)
  })
  it('the first manifest’s flags do not leak to types that lack them (spread reset)', () => {
    const reversed = mergeManifestsIntoUnion([pants, jacket], ['PANTS', 'JACKET'])
    const c = reversed.groups.flatMap((g) => g.columns).find((x) => x.id === 'item_weight__unit')!
    expect(c.requiredWithParentForProductTypes).toEqual(['JACKET'])
  })
})
