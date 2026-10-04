// Incidents #16-#18 — the AddFixedPriceItem contract: every field eBay IT
// requires at listing creation must be present in the generated XML.
import { describe, it, expect } from 'vitest'
import { buildAddFixedPriceItemXml } from './ebay-trading-api.service.js'

const input = {
  sku: 'PARENT-SKU-1',
  title: 'T', description: 'D', categoryId: '9999', conditionId: '1000',
  country: 'IT', currency: 'EUR',
  location: 'Testville', postalCode: '99999', // a made-up town and postal code
  itemSpecifics: { Marca: 'XAVIA', Stagione: 'Tutte le stagioni' },
  variationSpecificNames: ['Colore'],
  variations: [{ sku: 'A', price: 75, quantity: 3, specifics: { Colore: 'Nero' } }],
}

describe('buildAddFixedPriceItemXml — eBay IT creation requirements', () => {
  const xml = buildAddFixedPriceItemXml(input)
  it('carries Location + PostalCode (item location error otherwise)', () => {
    expect(xml).toContain('<Location>Testville</Location>')
    expect(xml).toContain('<PostalCode>99999</PostalCode>')
  })
  it('carries listing-level ItemSpecifics (Marca — eBay code 71 otherwise)', () => {
    expect(xml).toContain('<ItemSpecifics>')
    expect(xml).toContain('<Name>Marca</Name>')
    expect(xml).toContain('<Value>XAVIA</Value>')
  })
  it('carries per-variation EAN default (code 21919301 otherwise)', () => {
    expect(xml).toContain('<VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails>')
  })
  it('OutOfStockControl is NOT sent (deprecated by eBay — incident #25; the account-level out-of-stock preference governs keep-alive)', () => {
    expect(xml).not.toContain('OutOfStockControl')
  })
  it('carries the parent SKU as the listing custom label (incident #30)', () => {
    expect(xml).toContain('<SKU>PARENT-SKU-1</SKU>')
  })
  it('numeric ConditionID (code 37 otherwise)', () => {
    expect(xml).toContain('<ConditionID>1000</ConditionID>')
  })
  it('E1: a blank condition sends no <ConditionID> at all (never a guessed New; a Revise keeps eBay\'s)', () => {
    expect(buildAddFixedPriceItemXml({ ...input, conditionId: '' })).not.toContain('ConditionID')
  })
  it('omits Location/specifics blocks cleanly when absent', () => {
    const bare = buildAddFixedPriceItemXml({ ...input, location: undefined, postalCode: undefined, itemSpecifics: {} })
    expect(bare).not.toContain('<Location>')
    expect(bare).not.toContain('<ItemSpecifics>')
  })
})
