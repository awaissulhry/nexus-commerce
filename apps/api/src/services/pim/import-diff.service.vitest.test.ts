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
// LX.F F5 — the ONE authority answers "is this a language we sell in?" here too.
const availableLanguages = vi.fn(async () => ['it', 'de', 'fr', 'nl', 'en'])
vi.mock('./market-languages.js', async () => ({
  ...(await vi.importActual<typeof import('./market-languages.js')>('./market-languages.js')),
  availableContentLanguages: () => availableLanguages(),
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

it('keeps German and French previews, write addresses, and refusals independent', async () => {
  getStudioSheet.mockImplementation(async ({ locale }) => ({ columns: [{ key: 'sku' }, { key: 'name', writeField: 'name', kind: 'text' }], rows: [{ id: 'p1', sku: 'XAVIA', values: { sku: cell('XAVIA'), name: { ...cell(`Before ${locale}`), contentAddress: { tier: 'language', language: locale } } } }] }))
  const diff = await computeImportDiff({ productId: 'p1', market: 'IT', headerRow: ['sku', 'name@de', 'name@fr'], rows: [{ sku: 'XAVIA', 'name@de': 'Deutsch', 'name@fr': 'Français' }], blankPolicy: 'ignore', validateBatch: async candidates => {
    expect(candidates.map(c => c.contentAddress)).toEqual([{ tier: 'language', language: 'de' }, { tier: 'language', language: 'fr' }])
    return new Map([['p1:name@de', 'German refusal']])
  } })
  expect(diff.cells.filter(c => c.fieldKey === 'name').map(c => [c.scope.locale, c.before, c.verdict])).toEqual([['de', 'Before de', 'refused'], ['fr', 'Before fr', 'changed']])
  expect(parseHeader('title@amazon:BE:fr-BE')?.scope.locale).toBe('fr')
  expect(parseHeader('title@amazon:BE:fr@de')).toBeNull()
})

it('LX.F P2-18 — both locale positions accept the same tags and normalise them', () => {
  // The master position used to gate on /^[a-z]{2,3}$/, so these three parsed on a
  // channel coordinate and returned null (an unrecognised column) on master.
  for (const raw of ['title@de', 'title@DE', 'title@de-DE', 'title@de_DE']) {
    expect(parseHeader(raw), raw).toMatchObject({ fieldKey: 'title', scope: { kind: 'master', locale: 'de' } })
  }
  expect(parseHeader('title@amazon:IT:de-DE')?.scope).toMatchObject({ kind: 'channel', marketplace: 'IT', locale: 'de' })
  // POSITIVE CONTROL for the rejection arm: the permissive shape still refuses a
  // non-language, and the normaliser's throw is the rejection rather than a crash.
  expect(parseHeader('title@1x')).toBeNull()
  expect(parseHeader('title@toolongforalanguage')).toBeNull()
  expect(parseHeader('brand')).toMatchObject({ scope: { kind: 'master', locale: null } })
})

it('LX.F P2-13 / F3 — ONE header grammar, round-tripped arm by arm', async () => {
  const { contentHeaderKey } = await import('@nexus/shared/content-header')
  const arms: Array<[string, Parameters<typeof contentHeaderKey>[1], string, Record<string, unknown>]> = [
    // The one that changed a TIER: the web writer dropped the language on a master
    // scope, so a German master export round-tripped onto the Italian source.
    ['title', { kind: 'master', locale: 'de' }, 'title@de', { kind: 'master', locale: 'de' }],
    ['title', { kind: 'master', locale: 'de-DE' }, 'title@de', { kind: 'master', locale: 'de' }],
    ['brand', { kind: 'master' }, 'brand', { kind: 'master', locale: null }],
    // Casing and the trailing colon: one spelling now, and it parses back to the same
    // coordinate either way (the parser upper-cases), so no existing file changes meaning.
    ['title', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'de' }, 'title@amazon:IT:de', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'de' }],
    ['brand', { kind: 'channel', channel: 'amazon', marketplace: 'it' }, 'brand@amazon:IT:', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: null }],
    ['description', { kind: 'channel', channel: 'EBAY', marketplace: 'DE', locale: 'de_DE' }, 'description@ebay:DE:de', { kind: 'channel', channel: 'EBAY', marketplace: 'DE', locale: 'de' }],
  ]
  for (const [field, scope, header, parsed] of arms) {
    expect(contentHeaderKey(field, scope), `${field} ${JSON.stringify(scope)}`).toBe(header)
    expect(parseHeader(header)?.scope, header).toMatchObject(parsed)
    expect(parseHeader(header)?.fieldKey, header).toBe(field)
  }
  // The FORM rides before the coordinate, and survives the round trip.
  expect(contentHeaderKey('keywords', { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'de' }, 'list')).toBe('keywords[]@amazon:IT:de')
  expect(parseHeader('keywords[]@amazon:IT:de')).toMatchObject({ fieldKey: 'keywords', form: 'list', scope: { locale: 'de' } })
  // POSITIVE CONTROL that there is only ONE writer now. The web module cannot be
  // imported here (its own imports use the web's path aliases), so the claim is made
  // against its SOURCE: `exportKeyFor` delegates to the shared grammar and no longer
  // composes a header itself.
  const { readFileSync } = await import('node:fs')
  const webExport = readFileSync(new URL('../../../../web/src/app/products/[id]/edit/_studio/sheet/sheetExport.ts', import.meta.url), 'utf8')
  const body = webExport.slice(webExport.indexOf('export function exportKeyFor'))
  const fn = body.slice(0, body.indexOf('\n}') + 2)
  expect(fn).toContain('return contentHeaderKey(key, scope, form)')
  expect(fn).not.toContain('@${')   // no second composition
  expect(webExport).toContain("from '@nexus/shared/content-header'")
})

it('LX.F F5 — a language the authority does not know is an UNKNOWN COLUMN, never a write', async () => {
  // `parseHeader` validates the SHAPE of a locale, not its existence, so `name@zz` used
  // to parse as `{tier:'language', language:'zz'}` and a write would have created a
  // ProductTranslation row in a language nothing sells in — while the catalogue path
  // (`catalog-translate.ts:68`) refused exactly that value. One rule now.
  getStudioSheet.mockResolvedValue({ columns: [{ key: 'name', label: 'Name', writeField: 'name', kind: 'text', editable: true }], rows: [{ id: 'p1', sku: 'XAVIA', values: { name: { value: 'Giacca' } } }] })
  const diff = await computeImportDiff({ productId: 'p1', market: 'IT', headerRow: ['sku', 'name@zz', 'name@de'],
    rows: [{ sku: 'XAVIA', 'name@zz': 'Nonsense', 'name@de': 'Deutsch' }], blankPolicy: 'ignore' } as never)
  expect(diff.unknownColumns).toContain('name@zz')
  expect(diff.cells.some(cell => cell.scope.locale === 'zz')).toBe(false)
  // POSITIVE CONTROL in the same run: the language the authority DOES know is diffed.
  expect(diff.cells.some(cell => cell.scope.locale === 'de')).toBe(true)
})
