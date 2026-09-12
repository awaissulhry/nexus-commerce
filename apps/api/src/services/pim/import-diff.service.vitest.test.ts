/**
 * The import diff's HEADER handling (D15.2, design V.5/V.6, 2026-09-04).
 *
 * Three kinds of column can arrive in a file, and each must be told apart on screen:
 *   - a KEY the scope declares → diffed;
 *   - a key NO scope declares → `unknownColumns`, reported, never applied;
 *   - an EMPTY key cell → `ignoredColumns`, an informational column the sheet's own export writes
 *     for humans (the identity band, the readiness verdicts). Skipped silently, NAMED by its label
 *     row so the drawer can say "2 informational columns ignored" — and a re-import of an
 *     unmodified export produces zero noise (D15.1).
 *
 * The sheet read is mocked: this asserts the DERIVATION over a file, not where data is stored.
 *
 * Run: npx vitest run src/services/pim/import-diff.service.vitest.test.ts
 */
import { describe, expect, it, vi } from 'vitest'

const getStudioSheet = vi.fn()
vi.mock('./studio-sheet.service.js', () => ({
  getStudioSheet: (...a: unknown[]) => getStudioSheet(...a),
}))

import { coerceByKind, computeImportDiff, fromFileForm, LIST_SEPARATOR, optionCodeFor, parseHeader } from './import-diff.service.js'

const cell = (value: unknown) => ({ value, writable: true, follows: false })
const SHEET = {
  columns: [{ key: 'sku' }, { key: 'brand' }, { key: 'item_name' }],
  rows: [
    { id: 'p1', sku: 'GALE-JACKET', aliasId: null, values: { sku: cell('GALE-JACKET'), brand: cell('Xavia'), item_name: cell('Gale jacket') } },
    { id: 'p2', sku: 'GALE-JACKET-S', aliasId: null, values: { sku: cell('GALE-JACKET-S'), brand: cell('Xavia'), item_name: cell(null) } },
  ],
}

describe('optionCodeFor — D15.2: a closed-list cell arrives as its label OR its code, both mean the code', () => {
  const country = { options: ['PK', 'IT'], optionLabels: { PK: 'Pakistan', IT: 'Italia' } }
  const yesNo = { options: [true, false], optionLabels: { true: 'Sì', false: 'No' } }
  it('a label resolves to its code; a code stays a code', () => {
    expect(optionCodeFor(country, 'Pakistan')).toBe('PK')
    expect(optionCodeFor(country, 'PK')).toBe('PK')
  })
  it('matches case-folded and trimmed — a spreadsheet re-cases things', () => {
    expect(optionCodeFor(country, ' pakistan ')).toBe('PK')
    expect(optionCodeFor(country, 'it')).toBe('IT')
  })
  it('🔴 returns the code in the TYPE the contract stores — a boolean select gives back false, not "false"', () => {
    expect(optionCodeFor(yesNo, 'No')).toBe(false)
    expect(optionCodeFor(yesNo, 'Sì')).toBe(true)
    expect(optionCodeFor(yesNo, 'false')).toBe(false)
  })
  it('passes an unknown value through untouched — the write path refuses it with the real reason', () => {
    expect(optionCodeFor(country, 'Mars')).toBe('Mars')
  })
  it('leaves a free-text column and a blank alone', () => {
    expect(optionCodeFor(undefined, 'Pakistan')).toBe('Pakistan')
    expect(optionCodeFor({}, 'Pakistan')).toBe('Pakistan')
    expect(optionCodeFor(country, '')).toBe('')
    expect(optionCodeFor(country, 7)).toBe(7)
  })
})

describe('computeImportDiff — a re-imported LABEL is unchanged (the 168-refusal shape)', () => {
  it('🔴 "Pakistan" against a stored "PK" is unchanged; "Italia" is a change to "IT"', async () => {
    getStudioSheet.mockResolvedValue({
      columns: [{ key: 'sku' }, { key: 'country_of_origin', options: ['PK', 'IT'], optionLabels: { PK: 'Pakistan', IT: 'Italia' } }],
      rows: [{ id: 'p1', sku: 'GALE-JACKET', aliasId: null, values: { sku: cell('GALE-JACKET'), country_of_origin: cell('PK') } }],
    })
    const same = await computeImportDiff({ productId: 'p1', market: 'IT', headerRow: ['sku', 'country_of_origin'], rows: [{ sku: 'GALE-JACKET', country_of_origin: 'Pakistan' }], blankPolicy: 'ignore' })
    expect(same.counts).toEqual({ unchanged: 2, changed: 0, refused: 0, wouldPin: 0 })
    const moved = await computeImportDiff({ productId: 'p1', market: 'IT', headerRow: ['sku', 'country_of_origin'], rows: [{ sku: 'GALE-JACKET', country_of_origin: 'Italia' }], blankPolicy: 'ignore' })
    const c = moved.cells.find((x) => x.fieldKey === 'country_of_origin')!
    expect(c.verdict).toBe('changed')
    expect(c.after).toBe('IT')
  })
})

describe('declared forms — key[] and key[measure] (AM.1 shapes)', () => {
  it('parseHeader strips the form and keeps the coordinate', () => {
    expect(parseHeader('keywords[]')).toMatchObject({ fieldKey: 'keywords', form: 'list', scope: { kind: 'master' } })
    expect(parseHeader('item_weight[measure]@AMAZON:IT:it')).toMatchObject({ fieldKey: 'item_weight', form: 'measure', scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'it' } })
    expect(parseHeader('brand')).toMatchObject({ fieldKey: 'brand', form: null })
    expect(parseHeader('[]')).toBeNull()
  })
  it('fromFileForm rebuilds a list from the declared separator and leaves a comma inside an item alone', () => {
    expect(fromFileForm('list', `Ventilato, Imbottitura rimovibile${LIST_SEPARATOR}Protezioni CE`)).toEqual(['Ventilato, Imbottitura rimovibile', 'Protezioni CE'])
    expect(fromFileForm('list', 'not_applicable')).toEqual(['not_applicable'])
    expect(fromFileForm('list', '')).toBe('')
  })
  it('fromFileForm parses "value unit" into a measure and passes an unparseable string through', () => {
    expect(fromFileForm('measure', '12.5 kilograms')).toEqual({ value: 12.5, unit: 'kilograms' })
    expect(fromFileForm('measure', '12,5 kilograms')).toEqual({ value: 12.5, unit: 'kilograms' })
    expect(fromFileForm('measure', '3')).toEqual({ value: 3 })
    expect(fromFileForm('measure', 'heavy')).toBe('heavy')
    expect(fromFileForm(null, '12.5 kilograms')).toBe('12.5 kilograms')
  })
  it('🔴 a re-imported list and measure are UNCHANGED — compared value to value, not String() to String()', async () => {
    getStudioSheet.mockResolvedValue({
      columns: [{ key: 'sku' }, { key: 'ghs', shape: 'list' }, { key: 'item_weight', shape: 'measure' }, { key: 'dg', shape: 'list', options: ['not_applicable', 'ghs'], optionLabels: { not_applicable: 'Non applicabile' } }],
      rows: [{ id: 'p1', sku: 'GALE-JACKET', aliasId: null, values: { sku: cell('GALE-JACKET'), ghs: cell(['H200', 'H201']), item_weight: cell({ unit: 'kilograms', value: 1.2 }), dg: cell(['not_applicable']) } }],
    })
    const same = await computeImportDiff({
      productId: 'p1', market: 'IT',
      headerRow: ['sku', 'ghs[]', 'item_weight[measure]', 'dg[]'],
      rows: [{ sku: 'GALE-JACKET', 'ghs[]': `H200${LIST_SEPARATOR}H201`, 'item_weight[measure]': '1.2 kilograms', 'dg[]': 'Non applicabile' }],
      blankPolicy: 'ignore',
    })
    expect(same.counts).toEqual({ unchanged: 4, changed: 0, refused: 0, wouldPin: 0 })
    const moved = await computeImportDiff({
      productId: 'p1', market: 'IT',
      headerRow: ['sku', 'ghs[]', 'item_weight[measure]'],
      rows: [{ sku: 'GALE-JACKET', 'ghs[]': 'H200', 'item_weight[measure]': '1.3 kilograms' }],
      blankPolicy: 'ignore',
    })
    expect(moved.cells.find((c) => c.fieldKey === 'ghs')).toMatchObject({ verdict: 'changed', after: ['H200'] })
    expect(moved.cells.find((c) => c.fieldKey === 'item_weight')).toMatchObject({ verdict: 'changed', after: { value: 1.3, unit: 'kilograms' } })
  })
})

describe('parseHeader — an empty key cell is not a key', () => {
  it('returns null for an empty header, so the caller can treat the column as informational', () => {
    expect(parseHeader('')).toBeNull()
    expect(parseHeader('   ')).toBeNull()
  })
})

describe('computeImportDiff — the three kinds of column', () => {
  it('🔴 an EMPTY key cell is IGNORED and named by its label; a known key is diffed; an unknown key is reported', async () => {
    getStudioSheet.mockResolvedValue(SHEET)
    const diff = await computeImportDiff({
      productId: 'p1',
      market: 'IT',
      // What the sheet's own export writes: `sku` first, the identity band and a readiness column
      // with EMPTY keys, then attributes — plus one header nobody declares.
      headerRow: ['sku', '', 'brand', '', 'weave_type'],
      labelRow: ['SKU', 'Identity (SKU, readiness)', 'Brand *', 'Readiness', 'Weave type'],
      rows: [
        { sku: 'GALE-JACKET', '': 'Ready', brand: 'Xavia', weave_type: 'x' },
        { sku: 'GALE-JACKET-S', '': 'Missing · 2', brand: 'Xavia Racing', weave_type: 'y' },
      ],
      blankPolicy: 'ignore',
    })
    expect(diff.ignoredColumns).toEqual(['Identity (SKU, readiness)', 'Readiness'])
    expect(diff.unknownColumns).toEqual(['weave_type'])
    expect(diff.unmatchedRows).toEqual([])
    // Only declared keys produce cells: sku + brand on two rows.
    expect(diff.cells.map((c) => `${c.rowId}:${c.fieldKey}:${c.verdict}`).sort()).toEqual([
      'p1:brand:unchanged',
      'p1:sku:unchanged',
      'p2:brand:changed',
      'p2:sku:unchanged',
    ])
    expect(diff.counts).toEqual({ unchanged: 3, changed: 1, refused: 0, wouldPin: 0 })
  })

  it('a key-only file (no label row) names an ignored column by its position, never by a guess', async () => {
    getStudioSheet.mockResolvedValue(SHEET)
    const diff = await computeImportDiff({
      productId: 'p1',
      market: 'IT',
      headerRow: ['sku', '', 'brand'],
      rows: [{ sku: 'GALE-JACKET', '': 'x', brand: 'Xavia' }],
      blankPolicy: 'ignore',
    })
    expect(diff.ignoredColumns).toEqual(['column 2'])
    expect(diff.unknownColumns).toEqual([])
  })

  it('🔴 D15.1 — an unmodified export re-imports with ZERO changes, ZERO unknowns and ZERO refusals', async () => {
    getStudioSheet.mockResolvedValue(SHEET)
    const diff = await computeImportDiff({
      productId: 'p1',
      market: 'IT',
      headerRow: ['sku', '', 'brand', 'item_name', ''],
      labelRow: ['SKU', 'Identity (SKU, readiness)', 'Brand *', 'Item name *', 'Readiness'],
      rows: [
        { sku: 'GALE-JACKET', brand: 'Xavia', item_name: 'Gale jacket', '': '' },
        { sku: 'GALE-JACKET-S', brand: 'Xavia', item_name: '', '': '' },
      ],
      blankPolicy: 'ignore',
    })
    expect(diff.counts).toEqual({ unchanged: 6, changed: 0, refused: 0, wouldPin: 0 })
    expect(diff.unknownColumns).toEqual([])
    expect(diff.ignoredColumns).toHaveLength(2)
  })

  it('a row whose sku matches nothing is reported, not guessed', async () => {
    getStudioSheet.mockResolvedValue(SHEET)
    const diff = await computeImportDiff({
      productId: 'p1',
      market: 'IT',
      headerRow: ['sku', 'brand'],
      rows: [{ sku: 'NOPE', brand: 'x' }],
      blankPolicy: 'ignore',
    })
    expect(diff.unmatchedRows).toEqual([{ rowIndex: 1, key: 'NOPE' }])
    expect(diff.cells).toEqual([])
  })
})

describe('boolean columns — the word the sheet rendered means the stored boolean (the 63-refusal shape)', () => {
  it('coerceByKind maps the rendered words and the spreadsheet forms, case-folded; leaves the rest and other kinds alone', () => {
    const col = { kind: 'boolean' }
    for (const w of ['Yes', 'yes', ' TRUE ', '1', 'y']) expect(coerceByKind(col, w)).toBe(true)
    for (const w of ['No', 'FALSE', '0', 'n']) expect(coerceByKind(col, w)).toBe(false)
    expect(coerceByKind(col, 'maybe')).toBe('maybe')
    expect(coerceByKind(col, false)).toBe(false)
    expect(coerceByKind({ kind: 'text' }, 'Yes')).toBe('Yes')
    expect(coerceByKind(undefined, 'Yes')).toBe('Yes')
  })
  it('🔴 a re-imported "No" against a stored false is UNCHANGED; "Yes" is a change to true (a boolean, not the word)', async () => {
    getStudioSheet.mockResolvedValue({
      columns: [{ key: 'sku' }, { key: 'skip_offer', kind: 'boolean', writeField: 'attr_skip_offer' }],
      rows: [
        { id: 'p1', sku: 'A', aliasId: null, values: { sku: cell('A'), skip_offer: cell(false) } },
        { id: 'p2', sku: 'B', aliasId: null, values: { sku: cell('B'), skip_offer: cell(false) } },
      ],
    })
    const diff = await computeImportDiff({
      productId: 'p1', market: 'IT', headerRow: ['sku', 'skip_offer'],
      rows: [{ sku: 'A', skip_offer: 'No' }, { sku: 'B', skip_offer: 'Yes' }],
      blankPolicy: 'ignore',
    })
    const skip = diff.cells.filter((c) => c.fieldKey === 'skip_offer')
    expect(skip.map((c) => c.verdict)).toEqual(['unchanged', 'changed'])
    expect(skip[1].after).toBe(true)
    expect(diff.counts).toEqual({ unchanged: 3, changed: 1, refused: 0, wouldPin: 0 })
  })
})

describe('writeField — the write path is told the WRITE field, the outcome names the sheet key', () => {
  it('🔴 every cell carries the contract\'s writeField (the sheet key when none), and the validator receives it', async () => {
    getStudioSheet.mockResolvedValue({
      columns: [{ key: 'sku' }, { key: 'brand' }, { key: 'skip_offer', kind: 'boolean', writeField: 'attr_skip_offer' }],
      rows: [{ id: 'p1', sku: 'A', aliasId: null, values: { sku: cell('A'), brand: cell('Xavia'), skip_offer: cell(false) } }],
    })
    const seen: { fieldKey: string; writeField: string }[] = []
    const diff = await computeImportDiff({
      productId: 'p1', market: 'IT', headerRow: ['sku', 'brand', 'skip_offer'],
      rows: [{ sku: 'A', brand: 'Acme', skip_offer: 'Yes' }],
      blankPolicy: 'ignore',
      validateBatch: async (cands) => {
        for (const c of cands) seen.push({ fieldKey: c.fieldKey, writeField: c.writeField })
        // The write path answers with the field it was TOLD.
        return new Map([['p1:attr_skip_offer', 'Field not editable on this listing']])
      },
    })
    expect(diff.cells.find((c) => c.fieldKey === 'brand')?.writeField).toBe('brand')
    expect(diff.cells.find((c) => c.fieldKey === 'skip_offer')?.writeField).toBe('attr_skip_offer')
    expect(seen).toEqual([{ fieldKey: 'brand', writeField: 'brand' }, { fieldKey: 'skip_offer', writeField: 'attr_skip_offer' }])
    const skip = diff.cells.find((c) => c.fieldKey === 'skip_offer')!
    expect(skip.verdict).toBe('refused')
    expect(skip.reason).toBe('Field not editable on this listing')
    expect(diff.cells.find((c) => c.fieldKey === 'brand')?.verdict).toBe('changed')
  })
})
