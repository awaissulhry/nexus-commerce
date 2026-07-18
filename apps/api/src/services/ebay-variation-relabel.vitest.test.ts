/** Owner SKU relabeling — XML builder regression. */
import { describe, it, expect } from 'vitest'
import { buildRelabelXml } from './ebay-variation-relabel.service.js'

describe('buildRelabelXml', () => {
  it('one Variation per relabel, identified by specifics, carrying the NEW sku', () => {
    const xml = buildRelabelXml('256566101420', [
      { fromSku: 'T1_Ne_L', toSku: 'GALE-JACKET-BLACK-MEN-L', specifics: { Colore: 'Nero', Taglia: 'L' } },
      { fromSku: 'T1_Gi_M', toSku: 'GALE-JACKET-YELLOW-MEN-M', specifics: { Colore: 'Giallo', Taglia: 'M' } },
    ])
    expect(xml).toContain('<ItemID>256566101420</ItemID>')
    expect((xml.match(/<Variation>/g) ?? []).length).toBe(2)
    expect(xml).toContain('<SKU>GALE-JACKET-BLACK-MEN-L</SKU>')
    expect(xml).toContain('<Name>Colore</Name><Value>Nero</Value>')
    expect(xml).not.toContain('T1_Ne_L') // old sku never sent — identity is the specifics
    expect(xml).toContain('ReviseFixedPriceItemRequest')
  })
  it('escapes XML in specifics values', () => {
    const xml = buildRelabelXml('1', [
      { fromSku: 'A', toSku: 'B', specifics: { Materiale: 'Poliestere & Nylon' } },
    ])
    expect(xml).toContain('Poliestere &amp; Nylon')
  })
})
