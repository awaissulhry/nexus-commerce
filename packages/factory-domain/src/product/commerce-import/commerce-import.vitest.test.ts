import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import type { RowValues } from '../../imports/importer'
import { parseRow } from '../../imports/plan'
import {
  colourwayCodeFromName,
  commerceStylesImporter,
  COMMERCE_IMPORT_LIMITS,
  judgeFamilies,
  knownRecordValues,
  planCommerceRow,
  productTypeOf,
  scaleFor,
  type CommerceFacts,
  type CommerceRow,
  type ScaleFact,
  type StyleFact,
} from './importer'
import { COMMERCE_EXPORT_HEADERS, COMMERCE_TEMPLATE_EXAMPLES } from './sample'
import { COMMERCE_LIVE_READ, commerceImportInfo } from './source'

/** B-W2b-209: a style started from a Nexus Commerce export file (PRD-265), pure. Made-up codes and names only. */

const size = (code: string, seq: number, label: string | null = null) => ({ code, label, seq, status: 'ACTIVE' })
const EU: ScaleFact = { id: 'scale-eu', code: 'EU-JKT', name: 'EU jacket', companyId: null, status: 'ACTIVE', sizes: [size('48', 1), size('50', 2), size('52', 3), size('54', 4)] }
const LETTERS: ScaleFact = { id: 'scale-abc', code: 'LETTERS', name: 'Letters', companyId: null, status: 'ACTIVE', sizes: [size('S', 1), size('M', 2), size('L', 3), size('XL', 4, 'Extra large')] }
const GLOVES: ScaleFact = { id: 'scale-glv', code: 'GLOVES', name: 'Gloves', companyId: null, status: 'ACTIVE', sizes: [size('S', 1), size('M', 2), size('L', 3)] }
const OTHERS: ScaleFact = { id: 'scale-b', code: 'B-ONLY', name: 'Company B', companyId: 'company-b', status: 'ACTIVE', sizes: [size('50', 1)] }

const facts = (extra: Partial<CommerceFacts> = {}): CommerceFacts => ({
  companyId: 'company-a',
  styles: new Map(),
  skus: new Map(),
  gtins: new Map(),
  scales: [EU, LETTERS, OTHERS],
  brands: [{ id: 'brand-1', code: 'BRD-01', names: ['Demo Moto S.r.l.', 'Demo Moto'] }],
  colours: [{ id: 'colour-black', code: 'NERO', names: ['Nero', 'Black'] }],
  ...extra,
})

const rows = (...values: RowValues[]): CommerceRow[] => values.map((entry, index) => ({ rowNumber: index + 2, values: entry }))
const sample = (): CommerceRow[] => rows(...COMMERCE_TEMPLATE_EXAMPLES)

describe('the importer and the export file', () => {
  it('reads a Commerce export by its own headers', () => {
    const headers = Object.values(COMMERCE_EXPORT_HEADERS)
    const mapping = mapHeaders(commerceStylesImporter.columns, headers)
    expect(mapping.issues).toEqual([])
    expect(mapping.columns.map((entry) => entry.column)).toEqual(Object.keys(COMMERCE_EXPORT_HEADERS))
    const parsed = parseRow(commerceStylesImporter, mapping.columns, { rowNumber: 3, cells: ['demo-tour-ner-50', 'DEMO-TOUR', 'Giacca', 'Nero', 50, 2009001000017, '', ''] }, { numberFormat: 'it' })
    expect(parsed.errors).toEqual([])
    expect(parsed.values).toMatchObject({ sku: 'DEMO-TOUR-NER-50', family: 'DEMO-TOUR', size: '50', gtin: '2009001000017' })
  })

  it('judges the whole sheet at once: one dry-run batch, one apply batch', () => {
    expect(commerceStylesImporter.maxRows).toBe(COMMERCE_IMPORT_LIMITS.rows)
    expect(commerceStylesImporter.batchSize).toBe(COMMERCE_IMPORT_LIMITS.rows)
    expect(commerceStylesImporter.keyColumns).toEqual(['sku'])
  })

  it('checks the cells of one row together', () => {
    const problems = (values: RowValues) => commerceStylesImporter.validateRow(values).map((issue) => issue.column)
    expect(problems({ sku: 'A-1', family: 'A', colour: 'Nero', size: '50' })).toEqual([])
    expect(problems({ sku: 'A-1', family: 'A', size: '50' })).toEqual(['colour'])
    expect(problems({ sku: 'A-1', family: 'A', colour: 'Nero' })).toEqual(['size'])
    expect(problems({ sku: 'A-1', colour: 'Nero', size: '50' })).toEqual(['family'])
    expect(problems({ sku: 'A-1', family: 'A', colour: 'Nero', size: '50', gtin: '2009001000018' })).toEqual(['gtin'])
    expect(problems({ sku: 'A-1', family: 'A', colour: '***', size: '50' })).toEqual(['colourCode'])
    expect(problems({ sku: 'A-1', family: 'THIS-FAMILY-CODE-IS-FAR-TOO-LONG', colour: 'Nero', size: '50' })).toEqual(['family'])
    expect(problems({ sku: 'A', family: 'B' })).toEqual(['size'])
    expect(problems({ sku: 'A', gtin: '2009001000017' })).toEqual(['gtin'])
    expect(problems({ sku: 'A', productType: 'Caschi' })).toEqual(['productType'])
  })

  it('makes codes and product types from words', () => {
    expect(colourwayCodeFromName('Nero')).toBe('NERO')
    expect(colourwayCodeFromName('Grigio antracite')).toBe('GRIGIO_ANTRA')
    expect(colourwayCodeFromName('Nero / Rosso fluo')).toBe('NERO_ROSSO_F')
    expect(colourwayCodeFromName('Blu navy è')).toBe('BLU_NAVY_E')
    expect(colourwayCodeFromName('***')).toBeNull()
    expect(productTypeOf('Giacche moto')).toBe('JACKET')
    expect(productTypeOf('Pantaloni')).toBe('TROUSERS')
    expect(productTypeOf('Tute intere')).toBe('SUIT')
    expect(productTypeOf('Guanti estivi')).toBe('GLOVES')
    expect(productTypeOf('Gilet airbag')).toBe('VEST')
    expect(productTypeOf('jacket')).toBe('JACKET')
    expect(productTypeOf('Caschi')).toBeNull()
  })
})

describe('one row\'s plan', () => {
  it('a new SKU is a CREATE with the codes it makes; the same SKU again UNCHANGED; on another cell an error', () => {
    const values = { sku: 'DEMO-TOUR-GRA-50', family: 'DEMO-TOUR', colour: 'Grigio antracite', size: '50', gtin: '200 9001 000031' }
    expect(planCommerceRow(values, null)).toEqual({ action: 'CREATE', after: { ...values, style: 'DEMO-TOUR', colourCode: 'GRIGIO_ANTRA', gtin: '2009001000031' } })
    const known = (style: string, colourCode: string, at: string) => ({ id: 'v1', values: knownRecordValues('DEMO-TOUR-GRA-50', { kind: 'sku', style, colourCode, size: at }) })
    expect(planCommerceRow(values, known('DEMO-TOUR', 'GRIGIO_ANTRA', '50'))).toEqual({ action: 'UNCHANGED' })
    const elsewhere = planCommerceRow(values, known('DEMO-TOUR', 'GRIGIO_ANTRA', '52'))
    expect(elsewhere.action).toBe('ERROR')
    expect(elsewhere.action === 'ERROR' && elsewhere.errors[0]!.message).toContain('is on style DEMO-TOUR (colourway GRIGIO_ANTRA, size 52) already')
  })

  it("a family's own row is UNCHANGED once its style exists", () => {
    const family = { sku: 'DEMO-TOUR', name: 'Giacca Touring Demo' }
    expect(planCommerceRow(family, null)).toMatchObject({ action: 'CREATE', after: { style: 'DEMO-TOUR' } })
    expect(planCommerceRow(family, { id: 's1', values: knownRecordValues('DEMO-TOUR', { kind: 'style', style: 'DEMO-TOUR' }) })).toEqual({ action: 'UNCHANGED' })
  })
})

describe('the families', () => {
  it('makes one style per family: name, type, season, colourways, the range in the scale\'s order, SKUs and barcodes', () => {
    const judged = judgeFamilies(sample(), facts())
    expect(judged.issues.every((list) => list.length === 0)).toBe(true)
    expect(judged.families).toHaveLength(1)
    expect(judged.families[0]).toEqual({
      family: 'DEMO-TOUR',
      styleCode: 'DEMO-TOUR',
      existingStyleId: null,
      name: 'Giacca Touring Demo',
      productType: 'JACKET',
      season: 'FW27',
      brandPartyId: null,
      sizeScaleId: 'scale-eu',
      sizes: ['50', '52'],
      newSizes: ['50', '52'],
      colourways: [
        { code: 'NERO', name: 'Nero', colourId: 'colour-black' },
        { code: 'GRIGIO_ANTRA', name: 'Grigio antracite', colourId: null },
      ],
      skus: [
        { rowNumber: 3, sku: 'DEMO-TOUR-NER-50', colourCode: 'NERO', size: '50', gtin: '2009001000017' },
        { rowNumber: 4, sku: 'DEMO-TOUR-NER-52', colourCode: 'NERO', size: '52', gtin: '2009001000024' },
        { rowNumber: 5, sku: 'DEMO-TOUR-GRA-50', colourCode: 'GRIGIO_ANTRA', size: '50', gtin: '2009001000031' },
        { rowNumber: 6, sku: 'DEMO-TOUR-GRA-52', colourCode: 'GRIGIO_ANTRA', size: '52', gtin: null },
      ],
      rowNumbers: [2, 3, 4, 5, 6],
    })
  })

  it('names a style from a Family name column, or from SKU rows that agree; refuses one it cannot name', () => {
    const child = (sku: string, extra: RowValues = {}) => ({ sku, family: 'DEMO-PNT', colour: 'Nero', size: sku.slice(-1) === '1' ? 'S' : 'M', ...extra })
    expect(judgeFamilies(rows(child('P1', { familyName: 'Pantalone Demo' }), child('P2')), facts()).families[0]!.name).toBe('Pantalone Demo')
    expect(judgeFamilies(rows(child('P1', { name: 'Pantalone Demo' }), child('P2', { name: 'Pantalone Demo' })), facts()).families[0]!.name).toBe('Pantalone Demo')
    const unnamed = judgeFamilies(rows(child('P1', { name: 'Pantalone Demo S' }), child('P2', { name: 'Pantalone Demo M' })), facts())
    expect(unnamed.families).toEqual([])
    expect(unnamed.issues[0]![0]!.message).toContain('Name the style')
  })

  it('picks the one scale that holds every size, by code or label; asks for one when several or none do', () => {
    expect(scaleFor(null, ['S', 'XL'], [EU, LETTERS], 'company-a')).toEqual({ scale: LETTERS })
    expect(scaleFor(null, ['S', 'EXTRA LARGE'], [EU, LETTERS], 'company-a')).toEqual({ scale: LETTERS })
    const two = scaleFor(null, ['S', 'M'], [LETTERS, GLOVES], 'company-a')
    expect('problem' in two && two.problem).toMatchObject({ column: 'sizeScale', message: expect.stringContaining('LETTERS, GLOVES') })
    const none = scaleFor(null, ['3XL'], [LETTERS], 'company-a')
    expect('problem' in none && none.problem.column).toBe('size')
    expect(scaleFor('letters', ['S'], [LETTERS, GLOVES], 'company-a')).toEqual({ scale: LETTERS })
    const theirs = scaleFor('B-ONLY', ['50'], [OTHERS], 'company-a')
    expect('problem' in theirs && theirs.problem.message).toContain('another company')
    // Another company's scale is never picked by itself.
    expect(scaleFor(null, ['50'], [OTHERS], 'company-a')).toMatchObject({ problem: { column: 'size' } })
  })

  it('starts a family whole or not at all', () => {
    const sheet = [...sample()]
    sheet[3] = { ...sheet[3]!, values: { ...sheet[3]!.values, size: '58' } }
    const judged = judgeFamilies(sheet, facts())
    expect(judged.families).toEqual([])
    // No scale holds 50, 52 and 58: a problem of the family, said on each of its rows.
    expect(judged.issues.every((list) => list.some((issue) => issue.message.includes('No size scale holds every size')))).toBe(true)

    const named = judgeFamilies(sample().map((row) => ({ ...row, values: { ...row.values, sizeScale: 'EU-JKT', ...(row.rowNumber === 4 ? { size: '58' } : {}) } })), facts())
    expect(judged.families).toEqual([])
    expect(named.issues[2]![0]!.message).toContain('EU-JKT has no active size 58')
    expect(named.issues[1]).toEqual([{ column: 'family', message: 'Family DEMO-TOUR is started whole or not at all: row 4 has a problem.' }])
  })

  it('refuses a cell twice, two colours making one code, a barcode twice, an unknown brand', () => {
    const base = { family: 'DEMO-GLV', colour: 'Nero', productType: 'Guanti' }
    const twice = judgeFamilies(rows({ sku: 'G-S', ...base, size: 'S', familyName: 'Guanto Demo' }, { sku: 'G-S2', ...base, size: 'S' }), facts())
    expect(twice.issues[1]![0]!.message).toBe('Colourway NERO in size S is the SKU of row 2 already.')
    const clash = judgeFamilies(rows({ sku: 'G-S', ...base, size: 'S', familyName: 'Guanto Demo' }, { sku: 'G-M', ...base, colour: 'Nero!', size: 'M' }), facts())
    expect(clash.issues[1]![0]!.message).toContain('Colours Nero and Nero! both make colourway NERO')
    const barcode = judgeFamilies(rows({ sku: 'G-S', ...base, size: 'S', familyName: 'Guanto Demo', gtin: '2009001000048' }, { sku: 'G-M', ...base, size: 'M', gtin: '2009001000048' }), facts())
    expect(barcode.issues[1]![0]!.message).toBe('The same barcode as row 2: a GTIN names one SKU.')
    const brand = judgeFamilies(rows({ sku: 'G-S', ...base, size: 'S', familyName: 'Guanto Demo', brand: 'Nobody' }), facts())
    expect(brand.issues[0]![0]!.message).toContain('No brand Nobody')
    const branded = judgeFamilies(rows({ sku: 'G-S', ...base, size: 'S', familyName: 'Guanto Demo', brand: 'demo moto' }), facts())
    expect(branded.families[0]!.brandPartyId).toBe('brand-1')
  })

  const draftStyle = (extra: Partial<StyleFact> = {}): StyleFact => ({
    id: 'style-1',
    code: 'DEMO-TOUR',
    companyId: 'company-a',
    status: 'DRAFT',
    lifecycle: 'CONCEPT',
    released: false,
    sizeScaleId: 'scale-eu',
    sizes: ['50'],
    colourways: [{ code: 'NERO', name: 'Nero' }],
    cells: new Map([['NERO|50', 'DEMO-TOUR-NER-50']]),
    ...extra,
  })

  it('adds new colours, sizes and SKUs to a style it started before; a file imported again adds nothing', () => {
    const known = new Map([['DEMO-TOUR-NER-50', { kind: 'sku' as const, style: 'DEMO-TOUR', colourCode: 'NERO', size: '50' }]])
    const judged = judgeFamilies(sample(), facts({ styles: new Map([['DEMO-TOUR', draftStyle()]]), skus: known }))
    expect(judged.issues.every((list) => list.length === 0)).toBe(true)
    expect(judged.families[0]).toMatchObject({ existingStyleId: 'style-1', sizes: ['50', '52'], newSizes: ['52'], colourways: [{ code: 'GRIGIO_ANTRA' }], rowNumbers: [4, 5, 6] })
    expect(judged.families[0]!.skus.map((entry) => entry.sku)).toEqual(['DEMO-TOUR-NER-52', 'DEMO-TOUR-GRA-50', 'DEMO-TOUR-GRA-52'])

    const all = new Map(COMMERCE_TEMPLATE_EXAMPLES.slice(1).map((row) => [row.sku!, { kind: 'sku' as const, style: 'DEMO-TOUR', colourCode: colourwayCodeFromName(row.colour!)!, size: row.size! }]))
    const again = judgeFamilies(sample(), facts({ styles: new Map([['DEMO-TOUR', draftStyle({ sizes: ['50', '52'] })]]), skus: all }))
    expect(again).toEqual({ issues: sample().map(() => []), families: [] })
  })

  it("refuses to add to a style past development, another company's or archived, and a SKU on another cell", () => {
    const fresh = (style: StyleFact) => judgeFamilies(sample(), facts({ styles: new Map([['DEMO-TOUR', style]]) })).issues[1]![0]!.message
    expect(fresh(draftStyle({ lifecycle: 'SAMPLING' }))).toBe('Style DEMO-TOUR is past development (sampling): add its new colours and sizes on the style itself.')
    expect(fresh(draftStyle({ released: true, status: 'ACTIVE', lifecycle: 'IN_PRODUCTION' }))).toContain('past development (in production)')
    expect(fresh(draftStyle({ companyId: null }))).toContain("every company's")
    expect(fresh(draftStyle({ status: 'ARCHIVED' }))).toContain('archived')
    const elsewhere = judgeFamilies(sample(), facts({ skus: new Map([['DEMO-TOUR-NER-52', { kind: 'sku', style: 'OTHER-01', colourCode: 'BLK', size: '52' }]]) }))
    expect(elsewhere.families).toEqual([])
    expect(elsewhere.issues[2]![0]!.message).toContain('is on style OTHER-01')
    expect(elsewhere.issues[1]![0]!.message).toBe('Family DEMO-TOUR is started whole or not at all: row 4 has a problem.')
  })

  it('refuses rows that make different style codes, and a family without SKU rows', () => {
    const split = judgeFamilies(rows({ sku: 'X-1', family: 'X', colour: 'Nero', size: '50', familyName: 'X' }, { sku: 'X-2', family: 'X', style: 'Y', colour: 'Nero', size: '52' }), facts())
    expect(split.issues[0]![0]!.message).toContain('make different style codes')
    const alone = judgeFamilies(rows({ sku: 'SOLO', name: 'Solo' }), facts())
    expect(alone.issues[0]![0]!.message).toBe('Family SOLO has no SKU row (with colour and size) in the sheet: a style needs its colours and sizes.')
  })
})

describe('the sources', () => {
  it('reads the file only: the live read of Commerce is OFF, waiting for the Owner\'s word', () => {
    expect(COMMERCE_LIVE_READ).toEqual({ state: 'OFF', reasonCode: 'OWNER_WORD' })
    expect(commerceImportInfo()).toEqual({
      importerKey: 'product.commerceStyles',
      maxRows: COMMERCE_IMPORT_LIMITS.rows,
      formats: ['csv', 'xlsx'],
      sources: [
        { source: 'EXPORT_FILE', state: 'ON', reasonCode: null },
        { source: 'LIVE_READ', state: 'OFF', reasonCode: 'OWNER_WORD' },
      ],
    })
  })
})
