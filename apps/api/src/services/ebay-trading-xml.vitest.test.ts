// Incidents #16-#18 — the AddFixedPriceItem contract: every field eBay IT
// requires at listing creation must be present in the generated XML.
import { describe, it, expect } from 'vitest'
import { buildAddFixedPriceItemXml } from './ebay-trading-api.service.js'

const input = {
  title: 'T', description: 'D', categoryId: '9999', conditionId: '1000',
  country: 'IT', currency: 'EUR',
  location: 'Santarcangelo di Romagna', postalCode: '47822',
  itemSpecifics: { Marca: 'XAVIA', Stagione: 'Tutte le stagioni' },
  variationSpecificNames: ['Colore'],
  variations: [{ sku: 'A', price: 75, quantity: 3, specifics: { Colore: 'Nero' } }],
}

describe('buildAddFixedPriceItemXml — eBay IT creation requirements', () => {
  const xml = buildAddFixedPriceItemXml(input)
  it('carries Location + PostalCode (item location error otherwise)', () => {
    expect(xml).toContain('<Location>Santarcangelo di Romagna</Location>')
    expect(xml).toContain('<PostalCode>47822</PostalCode>')
  })
  it('carries listing-level ItemSpecifics (Marca — eBay code 71 otherwise)', () => {
    expect(xml).toContain('<ItemSpecifics>')
    expect(xml).toContain('<Name>Marca</Name>')
    expect(xml).toContain('<Value>XAVIA</Value>')
  })
  it('carries per-variation EAN default (code 21919301 otherwise)', () => {
    expect(xml).toContain('<VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails>')
  })
  it('OutOfStockControl keeps zero-stock listings alive (incident #22)', () => {
    expect(xml).toContain('<OutOfStockControl>true</OutOfStockControl>')
  })
  it('numeric ConditionID (code 37 otherwise)', () => {
    expect(xml).toContain('<ConditionID>1000</ConditionID>')
  })
  it('omits Location/specifics blocks cleanly when absent', () => {
    const bare = buildAddFixedPriceItemXml({ ...input, location: undefined, postalCode: undefined, itemSpecifics: {} })
    expect(bare).not.toContain('<Location>')
    expect(bare).not.toContain('<ItemSpecifics>')
  })
})
