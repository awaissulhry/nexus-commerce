/**
 * GALE root-cause regression — adopt listings AS THEY ARE on eBay.
 * Run: npx vitest run apps/api/src/services/ebay-membership-reconcile.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  specificsKey,
  parseLiveVariations,
  planMembershipReconcile,
} from './ebay-membership-reconcile.service.js'

describe('specificsKey', () => {
  it('order/case/space-insensitive', () => {
    expect(specificsKey({ Taglia: 'M', Colore: 'Nero' }))
      .toBe(specificsKey({ colore: ' nero ', taglia: 'm' }))
    expect(specificsKey({ Taglia: 'M' })).not.toBe(specificsKey({ Taglia: 'L' }))
  })
})

describe('parseLiveVariations', () => {
  it('extracts SKU + qty + specifics per variation', () => {
    const xml = `<GetItemResponse><Item><Variations>
      <Variation><SKU>T1_Ne_S</SKU><Quantity>24</Quantity>
        <VariationSpecifics>
          <NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList>
          <NameValueList><Name>Taglia</Name><Value>S</Value></NameValueList>
        </VariationSpecifics></Variation>
      <Variation><SKU>T1_Ne_M</SKU><Quantity>18</Quantity>
        <VariationSpecifics>
          <NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList>
          <NameValueList><Name>Taglia</Name><Value>M</Value></NameValueList>
        </VariationSpecifics></Variation>
      <Variation><Quantity>1</Quantity></Variation>
    </Variations></Item></GetItemResponse>`
    const live = parseLiveVariations(xml)
    expect(live).toHaveLength(2) // SKU-less variation skipped
    expect(live[0]).toEqual({ sku: 'T1_Ne_S', quantity: 24, specifics: { Colore: 'Nero', Taglia: 'S' } })
    expect(live[1].specifics.Taglia).toBe('M')
  })
})

describe('planMembershipReconcile — the GALE shape', () => {
  // Pool specifics are aspect-RICH (Brand, Marca, Stagione…); live variations
  // carry ONLY the axes. Subset matching is what makes adoption work.
  const rich = (extra: Record<string, string>) => ({
    Brand: 'XAVIA', Marca: 'Xavia Racing', Genere: 'Uomo', Stagione: 'Tutte le stagioni', ...extra,
  })
  const pool = [
    { productId: 'pid-BLACK-S', price: 105, specifics: rich({ Colore: 'Nero', Taglia: 'S', Size: 'S', Color: 'Nero' }) },
    { productId: 'pid-BLACK-M', price: 105, specifics: rich({ Colore: 'Nero', Taglia: 'M', Size: 'M', Color: 'Nero' }) },
    { productId: 'pid-YELLOW-L', price: 105, specifics: rich({ Colore: 'Giallo', Taglia: 'L', Size: 'L', Color: 'Giallo' }) },
  ]

  it('maps live axis-only specifics into aspect-rich pool entries (subset match)', () => {
    const live = [
      { sku: 'T1_Ne_S', quantity: 24, specifics: { Colore: 'Nero', Taglia: 'S' } },
      { sku: 'T1_Ne_M', quantity: 18, specifics: { Colore: 'Nero', Taglia: 'M' } },
      { sku: 'T1_Gi_L', quantity: 5, specifics: { Colore: 'Giallo', Taglia: 'L' } },
      { sku: 'T1_XX_9', quantity: 1, specifics: { Colore: 'Viola', Taglia: '9' } }, // not in pool
    ]
    const plan = planMembershipReconcile(live, pool)
    expect(plan.matched).toBe(3)
    expect(plan.unmatched).toEqual(['T1_XX_9'])
    expect(plan.entries[0]).toMatchObject({ liveSku: 'T1_Ne_S', productId: 'pid-BLACK-S', matched: true, price: 105 })
    expect(plan.entries[3]).toMatchObject({ liveSku: 'T1_XX_9', productId: null, matched: false })
  })

  it('ambiguous live axes (two distinct products both contain them) → unmatched, never guessed', () => {
    const live = [{ sku: 'AMB', quantity: 1, specifics: { Taglia: 'S' } }] // S exists in BLACK and… only BLACK here
    const ambiguousPool = [
      ...pool,
      { productId: 'pid-YELLOW-S', price: 105, specifics: rich({ Colore: 'Giallo', Taglia: 'S' }) },
    ]
    const plan = planMembershipReconcile(live, ambiguousPool)
    expect(plan.matched).toBe(0)
    expect(plan.unmatched).toEqual(['AMB'])
  })

  it('same product matching via multiple pool rows is NOT ambiguous', () => {
    const live = [{ sku: 'OK', quantity: 1, specifics: { Colore: 'Nero', Taglia: 'S' } }]
    const dupPool = [...pool, { productId: 'pid-BLACK-S', price: 99, specifics: rich({ Colore: 'Nero', Taglia: 'S' }) }]
    const plan = planMembershipReconcile(live, dupPool)
    expect(plan.matched).toBe(1)
    expect(plan.entries[0].productId).toBe('pid-BLACK-S')
  })
})
