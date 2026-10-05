import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { englishEbayAspectLabel, lookupEnglishAspectName } from '../ebay-aspect-names.js'
import { aspectNames, ebaySpecFromCache, type EbayCachedAspect } from './channel-specs/ebay.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { buildSheetColumns, issueFieldLabel, type SheetCoordinate } from './sheet-columns.service.js'
import { shopifyProductSpec } from './channel-specs/store.js'
import type { FieldDefinition } from './field-registry.service.js'

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
  // Item 12 (product sheet consistency, 2026-10-05) — publish takes all three from the product family, so the cells are
  // read-only, say why, and name the family's value in English on these columns only (Amazon's spec keeps its labels).
  // W3-6 — inside the Amazon scope its own fields carry no "Amazon " prefix (the Shared scope keeps it).
  it('shows the Amazon listing role, relationship type and parent SKU read-only, in English, the relationship type hidden by default', () => {
    const amazon: SheetCoordinate = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }
    const definition = JSON.parse(readFileSync(new URL('./__fixtures__/amazon-it-outerwear-family.json', import.meta.url), 'utf8'))
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: definition })
    const columns = buildSheetColumns({ fields: [], coordinates: [amazon], scopeKind: 'channel', specs: [{ coordinate: amazon, spec }] }).columns
    const byKey = new Map(columns.map(column => [column.key, column]))
    const role = byKey.get('parentage_level')!, type = byKey.get('child_parent_sku_relationship__child_relationship_type')!
    const parentSku = byKey.get('child_parent_sku_relationship__parent_sku')!
    expect(role).toMatchObject({ label: 'Listing role', editable: false, formulaWritable: false, options: ['parent', 'child'], optionLabels: { parent: 'Parent', child: 'Child' } })
    expect(type).toMatchObject({ label: 'Relationship type', editable: false, formulaWritable: false, defaultVisible: false, options: ['variation'], optionLabels: { variation: 'Variation' } })
    expect(parentSku).toMatchObject({ label: 'Parent SKU', editable: false, formulaWritable: false })
    for (const column of [role, type, parentSku]) expect(column.helpText).toMatch(/cannot be edited\.$/)
    for (const column of [role, parentSku]) expect(column.helpText).toMatch(/takes it from the product family/)
    // The channel spec keeps Amazon's market labels: paste, import and autocorrect still resolve them to codes.
    expect(spec.fields.find(f => f.key === 'parentage_level')?.optionLabels).toEqual({ parent: 'Articolo parent', child: 'Bambino' })
    // Only these columns: the variation theme keeps its own editing.
    expect(byKey.get('variation_theme')?.editable).toBe(true)
  })
  it('W3-4: the eBay condition column names its options in English and carries the market\'s words as accepted spellings', () => {
    const columns = buildSheetColumns({ fields: [], coordinates: [coordinate], scopeKind: 'channel',
      specs: [{ coordinate, spec: ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: cached.aspects, conditions: cached.conditions }) }] }).columns
    const condition = columns.find(c => c.key === 'conditionId')!
    expect(condition).toMatchObject({ options: ['NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'USED_EXCELLENT'], mode: 'strict',
      optionLabels: { NEW: 'New with tags', NEW_OTHER: 'New without tags', NEW_WITH_DEFECTS: 'New with defects', USED_EXCELLENT: 'Used' },
      optionAliases: { NEW: ['Nuovo con etichette'], NEW_OTHER: ['Nuovo senza etichette'], NEW_WITH_DEFECTS: ['Nuovo con difetti'], USED_EXCELLENT: ['Usato'] } })
    expect(columns.find(c => c.key === 'dimensionUnit')).toMatchObject({ options: ['CENTIMETER', 'METER', 'INCH', 'FEET'], optionLabels: { CENTIMETER: 'cm', METER: 'm', INCH: 'in', FEET: 'ft' } })
    expect(columns.find(c => c.key === 'packageType')!.optionLabels!.LARGE_ENVELOPE).toBe('Large envelope')
    // A column without accepted spellings carries none.
    expect(columns.find(c => c.key === 'listingFormat')!.optionAliases).toBeUndefined()
  })
  it('names every aspect in the cached Italian category in English and preserves its write address', () => {
    const columns = columnsFor(cached.aspects)
    const aspects = columns.filter(column => column.group === 'Item specifics')
    expect(Object.fromEntries(aspects.map(column => [column.key, column.label]))).toEqual({
      brand: 'Brand', adatto_a: 'Suitable for', size: 'Size', material: 'Material', color: 'Color',
      features: 'Features', season: 'Season', protection: 'Protection', style: 'Style',
      length: 'Length', width: 'Width', scollatura: 'Neckline', quantita: 'Unit quantity',
      colore_specifico: 'Specific color', closure_fastening: 'Closure / Fastening',
      cura_dell_indumento: 'Garment care', garanzia_produttore: 'Manufacturer warranty',
      paese_di_origine: 'Country of origin', unita_di_misura: 'Unit type', colore_esatto: 'Exact color',
    })
    const byKey = new Map(columns.map(column => [column.key, column]))
    expect(byKey.get('quantita')).toMatchObject({
      writeField: 'attr_quantita', channels: { 'eBay · IT': {
        attribute: 'aspect_Quantità', label: 'Quantità', store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Quantità'] },
      } },
    })
    // W3-6 — eBay's "Quantità" / "Unità di misura" are the unit price's parts, not stock; stock is "Qty" on a channel.
    // Display only: eBay's own names stay on the channel facts and the store path, which paste and publish read.
    expect(byKey.get('quantity')?.label).toBe('Qty')
    expect(byKey.get('unita_di_misura')?.channels?.['eBay · IT']).toMatchObject({ label: 'Unità di misura', store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Unità di misura'] } })
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

// W3-6 (2026-10-05) — one name for one thing: the sheet's naming table (`@nexus/shared/sheet-names`) names a column by
// its key on each scope. Display only — keys, write fields and the channels' own labels stay.
describe('one name for one thing (W3-6)', () => {
  const shopify: SheetCoordinate = { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }
  const amazon: SheetCoordinate = { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE', inMarket: true }
  const master = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'id' | 'label'>): FieldDefinition => ({ type: 'text', category: 'universal', editable: true, ...over })
  const registry = [
    master({ id: 'name', label: 'Name' }), master({ id: 'brand', label: 'Brand' }),
    master({ id: 'basePrice', label: 'Base Price', type: 'number', category: 'pricing' }), master({ id: 'minPrice', label: 'Min Price', type: 'number', category: 'pricing' }),
    master({ id: 'totalStock', label: 'Stock', type: 'number', category: 'inventory' }), master({ id: 'lowStockThreshold', label: 'Low Stock Alert', type: 'number', category: 'inventory' }),
  ]
  const labels = (columns: Array<{ key: string; label: string }>) => Object.fromEntries(columns.map(c => [c.key, c.label]))

  it('names the Shared product\'s fields in sentence case, with "Title" for the name', () => {
    const shared = labels(buildSheetColumns({ fields: registry, coordinates: [], scopeKind: 'master' }).columns)
    expect(shared).toMatchObject({ name: 'Title', brand: 'Brand', basePrice: 'Base price', minPrice: 'Min price', totalStock: 'Stock', lowStockThreshold: 'Low stock alert' })
  })

  it('says Title, Vendor, Price, Available and On hand on Shopify, and keeps Shopify\'s own names on the channel facts', () => {
    const columns = buildSheetColumns({ fields: registry, coordinates: [shopify], scopeKind: 'channel', specs: [{ coordinate: shopify, spec: shopifyProductSpec(null) }] }).columns
    expect(labels(columns)).toMatchObject({ name: 'Title', brand: 'Vendor', basePrice: 'Price', availableQuantity: 'Available', onHandQuantity: 'On hand' })
    const byKey = new Map(columns.map(c => [c.key, c]))
    expect(byKey.get('brand')).toMatchObject({ writeField: 'attr_brand', channels: { 'Shopify · GLOBAL': { attribute: 'vendor', label: 'Vendor' } } })
    expect(byKey.get('basePrice')?.channels?.['Shopify · GLOBAL']).toMatchObject({ attribute: 'price', store: { kind: 'listingColumn', column: 'price' } })
  })

  it('says Price and Title on eBay; eBay\'s Italian names stay on the channel facts', () => {
    const byKey = new Map(columnsFor([]).map(c => [c.key, c]))
    expect(byKey.get('price')).toMatchObject({ label: 'Price', channels: { 'eBay · IT': { label: 'Prezzo' } } })
    expect(byKey.get('name')?.label).toBe('Title')
    expect(byKey.get('videoId')?.label).toBe('Video ID')
  })

  it('names Amazon DE\'s RRP and eco fee without an English title, and a compound leaf through its parent', () => {
    const field = (key: string, attribute = key, path: string[] = []) => ({ key, attribute, path, label: key.toUpperCase(), kind: 'text' as const, shape: 'scalar' as const,
      cardinality: { min: 0, max: 1 }, requirement: 'optional' as const, requiredInParent: false, editable: true, hidden: false, variantEligible: false, group: null })
    const spec = { channel: 'AMAZON' as const, marketplace: 'DE', category: 'COAT', groups: [], fields: [field('uvp_list_price'), field('epr_eco_fee_eubr'), field('epr_eco_fee_eubr__currency', 'epr_eco_fee_eubr', ['currency'])],
      validationSchema: undefined, fetchedAt: null, schemaVersion: 'x', coverage: {}, unrecognised: [], absent: false }
    const columns = buildSheetColumns({ fields: [], coordinates: [amazon], scopeKind: 'channel', specs: [{ coordinate: amazon, spec: spec as never }] }).columns
    expect(labels(columns)).toMatchObject({ uvp_list_price: 'List price (UVP)', epr_eco_fee_eubr: 'EPR eco fee (EUBR)', epr_eco_fee_eubr__currency: 'EPR eco fee (EUBR) · Currency' })
  })

  it('names a readiness issue\'s field by its header, by the headers that carry its attribute, else in words — never a raw key', () => {
    const columns = [
      { key: 'brand', label: 'Brand' },
      { key: 'child_parent_sku_relationship__parent_sku', label: 'Parent SKU', channels: { 'Amazon · DE': { attribute: 'child_parent_sku_relationship' } } },
      { key: 'child_parent_sku_relationship__child_relationship_type', label: 'Relationship type', channels: { 'Amazon · DE': { attribute: 'child_parent_sku_relationship' } } },
    ] as never
    expect(issueFieldLabel(columns, 'brand', 'AMAZON')).toBe('Brand')
    expect(issueFieldLabel(columns, 'child_parent_sku_relationship', 'AMAZON')).toBe('Parent SKU, Relationship type')
    expect(issueFieldLabel(columns, 'uvp_list_price', 'AMAZON')).toBe('List price (UVP)')
    expect(issueFieldLabel(columns, 'supplier_declared_dg_hz_regulation', 'AMAZON')).toBe('Supplier declared dg hz regulation')
  })
})
