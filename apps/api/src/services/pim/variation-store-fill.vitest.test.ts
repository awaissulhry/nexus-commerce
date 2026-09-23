/**
 * Step 2.6d (A-27, R-26) — the fill plan. Rehearsed on the local catalogue before any production run: 78 products,
 * 77 sizes and 77 colours from eBay·IT, 1 contradicting legacy value dropped (the production counts), nothing left
 * after the write, no collision in the store, and `--revert` returns every count to its before-state.
 */
import { describe, expect, it } from 'vitest'
import { planVariationStoreFill, type FillChild } from './variation-store-fill.js'

const child = (id: string, over: Partial<FillChild> = {}): FillChild =>
  ({ id, sku: id, parentId: 'P', categoryAttributes: {}, variantAttributes: null, ebaySpecifics: null, ...over })
const plan = (children: FillChild[], declared: string[] = []) => planVariationStoreFill(children, new Map([['P', declared]]))

describe('FILL — a child with no size or colour anywhere takes the live eBay·IT value', () => {
  it('uses the spelling its siblings already store', () => {
    const [action] = plan([child('a', { ebaySpecifics: { Taglia: 'M', Colore: 'Nero', Marca: 'X' } }),
      child('b', { categoryAttributes: { variations: { Size: 'L', Color: 'Giallo' } } })])
    expect(action).toMatchObject({ id: 'a', plan: { set: { Size: 'M', Color: 'Nero' }, unset: [], legacyDrop: [] } })
  })
  it('falls back to the parent\'s declared axis, then to the eBay name (AIREON: no sibling stores anything)', () => {
    expect(plan([child('a', { ebaySpecifics: { Taglia: 'XS' } })], ['Colore', 'Taglia'])[0]!.plan.set).toEqual({ Taglia: 'XS' })
    expect(plan([child('a', { ebaySpecifics: { Taglia: 'XS' } })], [])[0]!.plan.set).toEqual({ Taglia: 'XS' })
  })
  it('keeps the value exactly as eBay shows it when the family has no name for it (the suffix keeps AIREON jackets and pants apart)', () => {
    expect(plan([child('a', { ebaySpecifics: { Colore: ['Nero Neo | Giacca'] } })])[0]!.fills).toEqual([{ axis: 'color', key: 'Colore', value: 'Nero Neo | Giacca', from: 'eBay·IT' }])
  })
  it('uses the family\'s own name when every sibling holding both agrees (VENTRA, seen on the production dry run)', () => {
    const sibling = (id: string, store: string) => child(id, { categoryAttributes: { variations: { Color: store, Size: 'L' } }, ebaySpecifics: { Colore: 'Rosso | Donna', Taglia: 'L' } })
    const [action] = plan([child('a', { ebaySpecifics: { Colore: 'Rosso | Donna', Taglia: 'XXS' } }), sibling('b', 'Grigio-Rosso-Nero | Donna'), sibling('c', 'Grigio-Rosso-Nero | Donna')])
    expect(action!.fills).toEqual([{ axis: 'size', key: 'Size', value: 'XXS', from: 'eBay·IT' }, { axis: 'color', key: 'Color', value: 'Grigio-Rosso-Nero | Donna', from: 'siblings' }])
    // Control: siblings that disagree teach nothing — the eBay value is kept.
    const [split] = plan([child('a', { ebaySpecifics: { Colore: 'Rosso | Donna' } }), sibling('b', 'Rosso'), sibling('c', 'Grigio-Rosso-Nero | Donna')])
    expect(split!.fills[0]).toMatchObject({ value: 'Rosso | Donna', from: 'eBay·IT' })
  })
  it('control: nothing is filled over a value the store or the legacy bag already holds, or from an empty listing', () => {
    expect(plan([child('a', { categoryAttributes: { variations: { Size: 'L' } }, ebaySpecifics: { Taglia: 'M' } })])).toEqual([])
    expect(plan([child('a', { variantAttributes: { Taglia: 'L' }, ebaySpecifics: { Taglia: 'M' } })])).toEqual([])
    expect(plan([child('a', { ebaySpecifics: { Taglia: '', Colore: [] } }), child('b')])).toEqual([])
  })
})

describe('DROP — a legacy value that contradicts the store leaves the legacy bag', () => {
  it('AIR-MESH-JACKET-MEN-XXL-BLACK: legacy XS against the store\'s XXL', () => {
    const [action] = plan([child('a', { categoryAttributes: { variations: { Size: 'XXL', Color: 'Nero' } }, variantAttributes: { Size: 'XS', Color: 'Nero' } })])
    expect(action).toMatchObject({ drops: [{ key: 'Size', legacy: 'XS', store: 'XXL' }], plan: { set: {}, legacyDrop: ['Size'] } })
  })
  it('per key: of two legacy spellings, only the one that contradicts leaves (found by a mutation that escaped)', () => {
    const [action] = plan([child('a', { categoryAttributes: { variations: { Size: 'XXL' } }, variantAttributes: { Taglia: 'XXL', Size: 'XS' } })])
    expect(action!.plan.legacyDrop).toEqual(['Size'])
  })
  it('control: a legacy value that agrees (any case) stays', () => {
    expect(plan([child('a', { categoryAttributes: { variations: { Size: 'XXL' } }, variantAttributes: { Taglia: 'xxl' } })])).toEqual([])
  })
})
