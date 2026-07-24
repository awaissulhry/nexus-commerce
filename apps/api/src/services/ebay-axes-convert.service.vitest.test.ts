import { describe, it, expect } from 'vitest'
import { italianAxisName, parseVariationsForRename, buildAxisRenameReviseXml } from './ebay-axes-convert.service.js'

describe('italianAxisName', () => {
  it('maps English colour/size to Italian; leaves Italian/unknown untouched', () => {
    expect(italianAxisName('Color')).toBe('Colore')
    expect(italianAxisName('color')).toBe('Colore')
    expect(italianAxisName('Colour')).toBe('Colore')
    expect(italianAxisName('Size')).toBe('Taglia')
    expect(italianAxisName('Colore')).toBe('Colore')
    expect(italianAxisName('Taglia')).toBe('Taglia')
    expect(italianAxisName('Sesso')).toBe('Sesso')
  })
})

describe('parseVariationsForRename', () => {
  const raw = `<Variations>
    <Variation><SKU>X-NERO</SKU><VariationSpecifics><NameValueList><Name>Color</Name><Value>Nero</Value></NameValueList></VariationSpecifics><VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails></Variation>
    <Variation><SKU>X-BLU</SKU><VariationSpecifics><NameValueList><Name>Color</Name><Value>Blu</Value></NameValueList></VariationSpecifics></Variation>
    <VariationSpecificsSet><NameValueList><Name>Color</Name><Value>Nero</Value><Value>Blu</Value></NameValueList></VariationSpecificsSet>
  </Variations>`
  it('extracts variations (SKU, specifics, EAN) + the axis set', () => {
    const { vars, axisSet } = parseVariationsForRename(raw)
    expect(vars.map((v) => v.sku)).toEqual(['X-NERO', 'X-BLU'])
    expect(vars[0].specifics).toEqual([['Color', 'Nero']])
    expect(vars[0].ean).toBe('Does not apply')
    expect(vars[1].ean).toBe('Does not apply') // missing EAN → default
    expect(axisSet).toEqual([{ name: 'Color', values: ['Nero', 'Blu'] }])
  })
})

describe('buildAxisRenameReviseXml', () => {
  it('renames the axis in BOTH the set and every variation, keeps SKU + EAN, matches by SKU', () => {
    const { vars, axisSet } = parseVariationsForRename(`<Variations><Variation><SKU>X-NERO</SKU><VariationSpecifics><NameValueList><Name>Color</Name><Value>Nero</Value></NameValueList></VariationSpecifics><VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails></Variation><VariationSpecificsSet><NameValueList><Name>Color</Name><Value>Nero</Value></NameValueList></VariationSpecificsSet></Variations>`)
    const xml = buildAxisRenameReviseXml('123', vars, axisSet)
    expect(xml).toContain('<ItemID>123</ItemID>')
    expect(xml).toContain('<VariationSpecificsSet><NameValueList><Name>Colore</Name>')
    expect(xml).toContain('<Variation><SKU>X-NERO</SKU><VariationSpecifics><NameValueList><Name>Colore</Name><Value>Nero</Value>')
    expect(xml).toContain('<VariationProductListingDetails><EAN>Does not apply</EAN></VariationProductListingDetails>')
    expect(xml).not.toContain('<Name>Color</Name>') // no English axis name left anywhere
  })
  it('escapes XML-special characters in SKUs and values', () => {
    const xml = buildAxisRenameReviseXml('1', [{ sku: 'S&1', specifics: [['Color', 'A<B']], ean: 'x' }], [{ name: 'Color', values: ['A<B'] }])
    expect(xml).toContain('S&amp;1')
    expect(xml).toContain('A&lt;B')
  })
})
