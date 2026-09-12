import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { englishEbayAspectLabel, lookupEnglishAspectName } from '../ebay-aspect-names.js'
import { aspectNames, ebaySpecFromCache, type EbayCachedAspect } from './channel-specs/ebay.js'
import { buildSheetColumns, type SheetCoordinate } from './sheet-columns.service.js'

const coordinate: SheetCoordinate = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true }
const cached = JSON.parse(readFileSync(new URL('./channel-specs/__tests__/fixtures/ebay-it-177104.json', import.meta.url), 'utf8'))
const columnsFor = (aspects: EbayCachedAspect[]) => buildSheetColumns({
  fields: [], coordinates: [coordinate], scopeKind: 'channel',
  specs: [{ coordinate, spec: ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects }) }],
}).columns

describe('English Information grid headings', () => {
  it('distinguishes saved Amazon parentage from the calculated catalog role', () => {
    const columns = buildSheetColumns({ fields: [{ id: 'attr_parentage_level', label: 'Parentage level', type: 'select', category: 'category', options: ['parent', 'child'] }], coordinates: [], scopeKind: 'master' }).columns
    expect(columns.find(c => c.key === 'parentage_level')).toMatchObject({ label: 'Saved Amazon parentage level', writeField: 'attr_parentage_level', storage: 'categoryAttributes', options: ['parent', 'child'] })
  })
  it('names every aspect in the cached Italian category in English and preserves its write address', () => {
    const columns = columnsFor(cached.aspects)
    const aspects = columns.filter(column => column.group === 'Item specifics')
    expect(Object.fromEntries(aspects.map(column => [column.key, column.label]))).toEqual({
      brand: 'Brand', adatto_a: 'Suitable for', size: 'Size', material: 'Material', color: 'Color',
      features: 'Features', season: 'Season', protection: 'Protection', style: 'Style',
      length: 'Length', width: 'Width', scollatura: 'Neckline', quantita: 'Quantity',
      colore_specifico: 'Specific color', closure_fastening: 'Closure / Fastening',
      cura_dell_indumento: 'Garment care', garanzia_produttore: 'Manufacturer warranty',
      paese_di_origine: 'Country of origin', unita_di_misura: 'Unit of measure', colore_esatto: 'Exact color',
    })
    const byKey = new Map(columns.map(column => [column.key, column]))
    expect(byKey.get('quantita')).toMatchObject({
      writeField: 'attr_quantita', channels: { 'eBay · IT': {
        attribute: 'aspect_Quantità', label: 'Quantità', store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Quantità'] },
      } },
    })
    expect(byKey.get('quantity')?.label).toBe('Available quantity')
    expect(byKey.get('scollatura')?.options).toEqual(cached.aspects.find((aspect: EbayCachedAspect) => aspect.label === 'Scollatura').options)
  })

  it.each([
    ['Marca', 'Brand'], ['Größe', 'Size'], ['Couleur', 'Color'], ['País de fabricación', 'Country of manufacture'],
    ['Età', 'Age'], ['Certificazione CE', 'CE certification'], ['Adatta', 'Fit'],
    ['Tipo di prodotto', 'Product type'], ['Materiale specifico', 'Specific material'],
    ['Materiale esatto', 'Exact material'], ['Caratteristiche aggiuntive', 'Additional features'], ['Armatura', 'Armor'],
    ['  Cura  dell’indumento  ', 'Garment care'],
  ])('resolves a heading missing English metadata: %s → %s', (localizedName, label) => {
    const columns = columnsFor([{ id: `aspect_${localizedName}`, label: localizedName, localizedName }])
    expect(columns.find(column => column.group === 'Item specifics')?.label).toBe(label)
  })

  it('keeps explicit English category wording and localized values', () => {
    const [aspect] = columnsFor([{
      id: 'aspect_Chiusura', label: 'Fastening (Chiusura)', localizedName: 'Chiusura', englishName: 'Fastening',
      kind: 'enum', options: ['Cerniera', 'Bottoni'],
    }]).filter(column => column.group === 'Item specifics')
    expect(aspect.label).toBe('Fastening')
    expect(aspect.options).toEqual(['Cerniera', 'Bottoni'])
    expect(aspect.channels?.[coordinate.label].store).toEqual({ kind: 'platformAttributes', path: ['itemSpecifics', 'Chiusura'] })
  })

  it('does not rename schema or mapping keys when a new display translation is added', () => {
    expect(englishEbayAspectLabel('Scollatura')).toBe('Neckline')
    expect(lookupEnglishAspectName('Scollatura')).toBeUndefined()
    expect(aspectNames({ id: 'aspect_Scollatura', label: 'Scollatura' })).toEqual({ localized: 'Scollatura', english: 'Scollatura' })
    expect(lookupEnglishAspectName('Marca')).toBe('Brand')
  })
})
