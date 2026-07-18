/** Add-variations-to-live-listing — pure parts. */
import { describe, it, expect } from 'vitest'
import { parseVariationSpecificsSet, extendSpecificsSet, buildAddVariationsXml } from './ebay-variation-add.service.js'

describe('parseVariationSpecificsSet', () => {
  it('extracts axis names + declared values', () => {
    const xml = `<Item><Variations><VariationSpecificsSet>
      <NameValueList><Name>Colore</Name><Value>Nero</Value><Value>Giallo</Value></NameValueList>
      <NameValueList><Name>Taglia</Name><Value>S</Value><Value>M</Value><Value>L</Value></NameValueList>
    </VariationSpecificsSet></Variations></Item>`
    expect(parseVariationSpecificsSet(xml)).toEqual({ Colore: ['Nero', 'Giallo'], Taglia: ['S', 'M', 'L'] })
  })
})

describe('extendSpecificsSet', () => {
  it('unions new values case-insensitively, preserving declared order', () => {
    const out = extendSpecificsSet(
      { Taglia: ['S', 'M'], Colore: ['Nero'] },
      [
        { sku: 'A', price: 105, quantity: 3, specifics: { Taglia: 'XXS', Colore: 'Nero' } },
        { sku: 'B', price: 105, quantity: 3, specifics: { Taglia: '5XL', Colore: 'Giallo' } },
        { sku: 'C', price: 105, quantity: 3, specifics: { Taglia: 's', Colore: 'giallo' } }, // dupes, case-diff
      ],
    )
    expect(out.Taglia).toEqual(['S', 'M', 'XXS', '5XL'])
    expect(out.Colore).toEqual(['Nero', 'Giallo'])
  })
})

describe('buildAddVariationsXml', () => {
  it('full extended set + ONLY new variations with price/qty/specifics', () => {
    const xml = buildAddVariationsXml(
      '256566101420',
      { Taglia: ['S', 'XXS'], Colore: ['Nero'] },
      [{ sku: 'GALE-JACKET-BLACK-MEN-XXS', price: 105, quantity: 7, specifics: { Taglia: 'XXS', Colore: 'Nero' } }],
    )
    expect(xml).toContain('<ItemID>256566101420</ItemID>')
    expect(xml).toContain('<VariationSpecificsSet><NameValueList><Name>Taglia</Name><Value>S</Value><Value>XXS</Value>')
    expect(xml).toContain('<SKU>GALE-JACKET-BLACK-MEN-XXS</SKU><StartPrice>105.00</StartPrice><Quantity>7</Quantity>')
    expect((xml.match(/<Variation>/g) ?? []).length).toBe(1)
  })
})
