/**
 * CX review 2026-09-26 — ONE StartPrice parser. Three existed (the Trading sweep's, the SKU-less adoption's in
 * ebay-variation-relabel, the axis rename's in ebay-axes-convert), each with its own regex and its own idea of
 * "absent". The census keeps it at one; the behaviour cases pin what each caller reads from it.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseStartPrice, parseGetItemQuantities } from './ebay-trading-api.service.js'
import { parseVariationsForRename, buildAxisRenameReviseXml } from './ebay-axes-convert.service.js'

const SRC = join(import.meta.dirname, '..')
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
  return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
})

describe('census — one StartPrice parser in the API source', () => {
  it('only ebay-trading-api.service.ts holds a regex that READS <StartPrice> (writers build it with template strings)', () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(100) // positive control: the walk saw the source tree
    const readers = files.filter((file) => readFileSync(file, 'utf8').includes('/<StartPrice')).map((file) => relative(SRC, file)).sort()
    expect(readers).toEqual(['services/ebay-trading-api.service.ts'])
  })
})

describe('parseStartPrice — value, currency and eBay\'s own text', () => {
  it('reads the number, the currencyID and the text as sent', () => {
    expect(parseStartPrice('<StartPrice currencyID="EUR">29.90</StartPrice>')).toEqual({ value: 29.9, currency: 'EUR', text: '29.90' })
    expect(parseStartPrice('<Variation><StartPrice currencyID=\'gbp\'> 5 </StartPrice></Variation>')).toEqual({ value: 5, currency: 'GBP', text: ' 5 ' })
  })
  it('absent → null; a price that is not a plain decimal → value null (never 0, never NaN); "0.00" is 0', () => {
    expect(parseStartPrice('<Variation><SKU>A</SKU></Variation>')).toBeNull()
    expect(parseStartPrice('<StartPrice currencyID="EUR">1.2.3</StartPrice>')).toEqual({ value: null, currency: 'EUR', text: '1.2.3' })
    expect(parseStartPrice('<StartPrice>abc</StartPrice>')).toEqual({ value: null, currency: null, text: 'abc' })
    expect(parseStartPrice('<StartPrice currencyID="EUR">0.00</StartPrice>')?.value).toBe(0)
  })
  it('the Trading sweep reads through it: per variation, and the item outside the variations', () => {
    const xml = '<GetItemResponse><Item><StartPrice currencyID="EUR">9.90</StartPrice><Variations><Variation><SKU>A</SKU><StartPrice currencyID="EUR">12.50</StartPrice><Quantity>1</Quantity></Variation></Variations></Item></GetItemResponse>'
    expect(parseGetItemQuantities(xml).prices).toEqual({ item: { value: 9.9, currency: 'EUR' }, variations: [{ sku: 'A', value: 12.5, currency: 'EUR' }], hasVariations: true })
  })
  it('the axis rename echoes eBay\'s text verbatim (a rename never moves money); absent → omitted', () => {
    const { vars, axisSet } = parseVariationsForRename('<Variations><Variation><SKU>A</SKU><StartPrice currencyID="EUR">29.90</StartPrice><Quantity>3</Quantity><VariationSpecifics><NameValueList><Name>Color</Name><Value>Nero</Value></NameValueList></VariationSpecifics></Variation><Variation><SKU>B</SKU><Quantity>1</Quantity></Variation><VariationSpecificsSet><NameValueList><Name>Color</Name><Value>Nero</Value></NameValueList></VariationSpecificsSet></Variations>')
    expect(vars.map((v) => v.startPrice)).toEqual(['29.90', ''])
    const xml = buildAxisRenameReviseXml('1', vars, axisSet)
    expect(xml).toContain('<SKU>A</SKU><StartPrice>29.90</StartPrice><Quantity>3</Quantity>')
    expect(xml).toContain('<SKU>B</SKU><Quantity>1</Quantity>')
  })
})
