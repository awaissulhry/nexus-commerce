import { describe, expect, it } from 'vitest'
import { parseMediaFileName, versionGroups } from './media-plan-files'

const ctx = {
  values: [
    { key: 'color:black', label: 'Nero', names: ['black', 'Nero', 'Schwarz', 'Noir'] },
    { key: 'color:yellow', label: 'Giallo', names: ['yellow', 'Giallo', 'Gelb'] },
    { key: 'color:navy_blue', label: 'Blu navy', names: ['navy_blue', 'Blu navy'] },
  ],
  skus: [{ productId: 'p-bm', sku: 'GALE-BLACK-M' }, { productId: 'p-bxl', sku: 'GALE-BLACK-XL' }],
}
const parse = (name: string) => parseMediaFileName(name, ctx)

describe('file-name rules', () => {
  it('reads the value and the position, in any language the value is known by', () => {
    expect(parse('gale-nero-01.jpg')).toMatchObject({ set: 'value:color:black', position: 1, language: 'zxx', reason: 'Nero in the name' })
    expect(parse('GALE_Giallo_3.PNG')).toMatchObject({ set: 'value:color:yellow', position: 3 })
    expect(parse('Gale Schwarz main.webp')).toMatchObject({ set: 'value:color:black', position: 1 })
    expect(parse('gale-blu-navy-02.jpg')).toMatchObject({ set: 'value:color:navy_blue', position: 2 })
  })
  it('reads a language as a version, and groups versions of one photo', () => {
    const it = parse('size-chart-it.jpg'), de = parse('size_chart_DE.png'), es = parse('Size Chart Espanol.jpg')
    expect([it.set, it.language, it.base]).toEqual(['common', 'it', 'size-chart'])
    expect([de.language, de.base, es.language, es.base]).toEqual(['de', 'size-chart', 'es', 'size-chart'])
    const groups = versionGroups([{ id: 'a', parsed: it }, { id: 'b', parsed: de }, { id: 'c', parsed: es }, { id: 'd', parsed: parse('gale-nero-01.jpg') }])
    expect([...groups.values()]).toEqual([['a', 'b', 'c']])
  })
  it('does not group two files of the same language, or a file without a language', () => {
    expect(versionGroups([{ id: 'a', parsed: parse('chart-it.jpg') }, { id: 'b', parsed: parse('chart-it (1).jpg') }]).size).toBe(0)
    expect(versionGroups([{ id: 'a', parsed: parse('chart.jpg') }, { id: 'b', parsed: parse('chart-de.jpg') }]).size).toBe(0)
  })
  it('a SKU wins over its value; the longest SKU wins over a shorter one', () => {
    expect(parse('GALE-BLACK-XL-2.jpg')).toMatchObject({ set: 'sku:p-bxl', position: 2 })
    expect(parse('gale-black-m.jpg')).toMatchObject({ set: 'sku:p-bm' })
  })
  it('reads safety images, Amazon slot names and swatches', () => {
    expect(parse('B000000001.PS02.jpg')).toMatchObject({ set: 'safety', position: 2 })
    expect(parse('nero-pt03.jpg')).toMatchObject({ set: 'value:color:black', position: 4 })
    expect(parse('swatch-giallo.jpg')).toMatchObject({ set: 'value:color:yellow', swatch: true, position: null })
  })
  it('never guesses between two values, and says why a file went to Common', () => {
    expect(parse('nero-giallo-combo.jpg')).toMatchObject({ set: 'common', reason: 'Names more than one value (Nero, Giallo) — choose one' })
    expect(parse('lifestyle-01.jpg')).toMatchObject({ set: 'common', position: 1, reason: 'Common photo' })
    expect(parse('IMG_4411.jpg')).toMatchObject({ set: 'common', reason: 'No value or SKU in the name — check it' })
  })
})
