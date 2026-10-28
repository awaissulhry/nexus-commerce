import { describe, expect, it } from 'vitest'
import { isMarkedJson } from '../money/marked'
import { cell } from './cells'
import { mapHeaders, normaliseHeader } from './headers'
import {
  defineImporter,
  grainsOf,
  importerRegistry,
  ImporterDefinitionError,
  keyOf,
  keyValues,
  markValues,
  unmarkValues,
  type ExistingRecord,
  type ImportColumn,
} from './importer'
import { importMachine, sheetTypeProblem } from './job'
import { applyCheck, isBlankRow, parseRow, planner, type SheetRow } from './plan'
import { canTransition } from '../state/machine'

// The engine with a made-up importer of "widgets": a code (the key), a name, a kind, a stock count and a unit price.
const widgets = defineImporter({
  key: 'test.widgets',
  label: 'Widgets',
  columns: {
    code: { label: 'Code', aliases: ['codice', 'sku'], required: true, type: cell.code({ upper: true }) },
    name: { label: 'Name', aliases: ['nome', 'descrizione'], required: true, type: cell.text({ max: 80 }) },
    kind: { label: 'Kind', aliases: ['tipo'], type: cell.oneOf(['PART', 'KIT'], { parte: 'PART' }) },
    stock: { label: 'Stock', aliases: ['giacenza', 'quantità'], type: cell.integer({ min: 0 }) },
    unitPrice: { label: 'Unit price', aliases: ['prezzo unitario', 'prezzo'], type: cell.decimal({ scale: 6 }), grain: 'price' },
  },
  keyColumns: ['code'],
  validateRow: (values) => (values.kind === 'KIT' && values.stock !== undefined ? [{ column: 'stock', message: 'A kit has no stock of its own.' }] : []),
})

const context = { numberFormat: 'it' as const }
const HEADERS = ['Codice', 'Descrizione', 'Tipo', 'Giacenza', 'Prezzo unitario (€)', 'Note']

function plan(rows: (string | number | null)[][], existing: Record<string, ExistingRecord> = {}) {
  const mapping = mapHeaders(widgets.columns, HEADERS)
  expect(mapping.issues).toEqual([])
  const sheet: SheetRow[] = rows.map((cells, index) => ({ rowNumber: index + 2, cells }))
  const parsed = sheet.filter((row) => !isBlankRow(row)).map((row) => parseRow(widgets, mapping.columns, row, context))
  const run = planner(widgets)
  return { rows: run.plan(parsed, new Map(Object.entries(existing))), counts: run.counts() }
}

describe('header mapping', () => {
  it('matches names, labels and aliases without case, accents or punctuation; ignores the rest', () => {
    const mapping = mapHeaders(widgets.columns, HEADERS)
    expect(mapping.columns.map((entry) => [entry.header, entry.column])).toEqual([
      ['Codice', 'code'],
      ['Descrizione', 'name'],
      ['Tipo', 'kind'],
      ['Giacenza', 'stock'],
      ['Prezzo unitario (€)', 'unitPrice'],
    ])
    expect(mapping.ignored).toEqual([{ index: 5, header: 'Note', reason: 'unknown' }])
    expect(mapHeaders(widgets.columns, ['CODE', 'unit_price', 'Quantita', 'nome']).columns.map((entry) => entry.column)).toEqual(['code', 'unitPrice', 'stock', 'name'])
    expect(normaliseHeader('unitPrice')).toBe('unit price')
    expect(normaliseHeader(' Prezzo   Unitario (€) ')).toBe('prezzo unitario')
  })

  it('says what is missing or ambiguous, and takes a person\'s overrides', () => {
    expect(mapHeaders(widgets.columns, ['Nome', 'Prezzo']).issues).toEqual([{ path: 'column/code', message: 'The sheet has no column for Code, which is required.' }])
    const twice = mapHeaders(widgets.columns, ['Codice', 'SKU', 'Nome'])
    expect(twice.issues).toEqual([{ path: 'column/code', message: 'The headers "Codice" and "SKU" both mean Code; map one of them to another column or ignore it.' }])
    const fixed = mapHeaders(widgets.columns, ['Codice', 'SKU', 'Articolo'], { SKU: null, articolo: 'name' })
    expect(fixed.issues).toEqual([])
    expect(fixed.columns.map((entry) => entry.column)).toEqual(['code', 'name'])
    expect(fixed.ignored).toEqual([{ index: 1, header: 'SKU', reason: 'ignored' }])
    expect(mapHeaders(widgets.columns, ['Codice', 'Nome'], { Nome: 'colour', Prezzo: 'unitPrice' }).issues).toEqual([
      { path: 'mapping/Nome', message: 'This import has no column colour.' },
      { path: 'mapping/Prezzo', message: 'The sheet has no column with this header.' },
      { path: 'column/name', message: 'The sheet has no column for Name, which is required.' },
    ])
  })
})

describe('defineImporter', () => {
  const column = (fields: Partial<ImportColumn> = {}): ImportColumn => ({ label: 'X', required: true, type: cell.text(), ...fields })

  it('refuses a bad declaration at once', () => {
    expect(() => defineImporter({ key: 'widgets', label: 'W', columns: { code: column() }, keyColumns: ['code'] })).toThrow(/key is not <module>.<name>/)
    expect(() => defineImporter({ key: 'test.w', label: 'W', columns: { code: column({ required: false }) }, keyColumns: ['code'] })).toThrow(/must be required/)
    expect(() => defineImporter({ key: 'test.w', label: 'W', columns: { code: column({ grain: 'cost' }) }, keyColumns: ['code'] })).toThrow(/carries money/)
    expect(() => defineImporter({ key: 'test.w', label: 'W', columns: { code: column({ aliases: ['nome'] }), name: column({ label: 'Nome' }) }, keyColumns: ['code'] })).toThrow(/"nome" names both code and name/)
    expect(() => defineImporter({ key: 'test.w', label: 'W', columns: { code: column() }, keyColumns: ['code'], maxRows: 1_000_000 })).toThrow(ImporterDefinitionError)
  })

  it('keys, grains and money marking', () => {
    expect(keyOf(widgets, { code: 'A-1', name: 'x' })).toBe('["A-1"]')
    expect(keyOf(widgets, { name: 'x' })).toBeNull()
    expect(keyValues(widgets, '["A-1"]')).toEqual({ code: 'A-1' })
    expect(grainsOf(widgets, ['code', 'unitPrice', 'stock'])).toEqual(['price'])
    const stored = markValues(widgets, { name: 'Bolt', unitPrice: '1.5' })
    expect(stored.name).toBe('Bolt')
    expect(isMarkedJson(stored.unitPrice)).toBe(true)
    expect(unmarkValues(JSON.parse(JSON.stringify(stored)))).toEqual({ name: 'Bolt', unitPrice: '1.5' })
  })

  it('a registry refuses two importers with one key', () => {
    expect(importerRegistry([{ importer: widgets }]).get('test.widgets')?.importer).toBe(widgets)
    expect(() => importerRegistry([{ importer: widgets }, { importer: widgets }])).toThrow(/registered twice/)
  })
})

describe('the dry run', () => {
  it('plans create, update, unchanged and error rows, keeping the sheet\'s row numbers', () => {
    const existing = {
      '["B-2"]': { id: 'rec-b', values: { code: 'B-2', name: 'Nut', kind: 'PART', stock: 4, unitPrice: '0.25' } },
      '["C-3"]': { id: 'rec-c', values: { code: 'C-3', name: 'Washer', kind: 'PART', stock: 9, unitPrice: '0.1' } },
    }
    const { rows, counts } = plan(
      [
        ['a-1', 'Bolt', 'parte', '1.200', '1,50', 'new'],
        ['B-2', 'Nut M6', 'PART', '4', '0,25', ''],
        ['C-3', 'Washer', 'part', '9', '0,100000', null],
        [null, null, null, null, null, null],
        ['D-4', '', 'KIT', '-1', 'tanti', ''],
        ['E-5', 'Kit', 'KIT', '3', '', ''],
      ],
      existing,
    )
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'UPDATE'],
      [4, 'UNCHANGED'],
      [6, 'ERROR'],
      [7, 'ERROR'],
    ])
    expect(rows[0]).toMatchObject({ key: '["A-1"]', after: { code: 'A-1', name: 'Bolt', kind: 'PART', stock: 1200, unitPrice: '1.5' } })
    expect(rows[1]).toMatchObject({ recordId: 'rec-b', before: { name: 'Nut' }, after: { name: 'Nut M6' } })
    expect(rows[2]).toMatchObject({ recordId: 'rec-c', before: null, after: null })
    // Every problem of a row at once, each naming its column.
    expect(rows[3]!.errors).toEqual([
      { column: 'name', message: 'Name is required.' },
      { column: 'stock', message: 'Expected a whole number from 0 to 2147483647.' },
      { column: 'unitPrice', message: 'Expected a number like 1.234,56 or 1234,56.' },
    ])
    expect(rows[4]!.errors).toEqual([{ column: 'stock', message: 'A kit has no stock of its own.' }])
    expect(counts).toEqual({ rows: 5, create: 1, update: 1, unchanged: 1, error: 2 })
  })

  it('a repeated key is an error after its first row, across batches too', () => {
    const mapping = mapHeaders(widgets.columns, ['Codice', 'Nome']).columns
    const run = planner(widgets)
    const batch = (rows: [number, string][]) => run.plan(rows.map(([rowNumber, code]) => parseRow(widgets, mapping, { rowNumber, cells: [code, 'x'] }, context)), new Map())
    expect(batch([[2, 'A'], [3, 'a']]).map((row) => row.action)).toEqual(['CREATE', 'ERROR'])
    const [later] = batch([[9, 'A']])
    expect(later).toMatchObject({ action: 'ERROR', errors: [{ message: 'The same Code as row 2; only the first one is imported.' }] })
  })

  it('a blank cell is never a change: only given values are compared and written', () => {
    const { rows } = plan([['B-2', 'Nut', '', '', '', '']], { '["B-2"]': { id: 'rec-b', values: { code: 'B-2', name: 'Nut', kind: 'KIT', stock: null, unitPrice: '9' } } })
    expect(rows[0]!.action).toBe('UNCHANGED')
  })

  it('an importer\'s own plan can refuse a row', () => {
    const strict = defineImporter({
      key: 'test.strict',
      label: 'Strict',
      columns: { code: { label: 'Code', required: true, type: cell.code() }, kind: { label: 'Kind', type: cell.oneOf(['PART', 'KIT']) } },
      keyColumns: ['code'],
      plan: (values, existing) =>
        existing && values.kind !== undefined && values.kind !== existing.values.kind
          ? { action: 'ERROR', errors: [{ column: 'kind', message: 'A kind change needs a person; it is not imported.' }] }
          : existing
            ? { action: 'UNCHANGED' }
            : { action: 'CREATE', after: values },
    })
    const mapping = mapHeaders(strict.columns, ['code', 'kind']).columns
    const [row] = planner(strict).plan([parseRow(strict, mapping, { rowNumber: 2, cells: ['A', 'KIT'] }, context)], new Map([['["A"]', { id: 'r', values: { kind: 'PART' } }]]))
    expect(row).toMatchObject({ action: 'ERROR', errors: [{ column: 'kind', message: 'A kind change needs a person; it is not imported.' }] })
  })
})

describe('apply-time check', () => {
  const update = { action: 'UPDATE' as const, recordId: 'r', before: { name: 'Nut', unitPrice: '0.25' }, after: { name: 'Nut M6', unitPrice: '0.3' } }

  it('applies only rows whose record is as the dry run saw it', () => {
    expect(applyCheck(widgets, { action: 'CREATE', recordId: null, before: null, after: { code: 'A' } }, null)).toEqual({ apply: true })
    expect(applyCheck(widgets, { action: 'CREATE', recordId: null, before: null, after: { code: 'A', name: 'x' } }, { id: 'r', values: { code: 'A', name: 'y' } })).toEqual({ apply: false, note: 'changed_since_dry_run' })
    expect(applyCheck(widgets, { action: 'CREATE', recordId: null, before: null, after: { code: 'A', name: 'x' } }, { id: 'r', values: { code: 'A', name: 'x' } })).toEqual({ apply: false, note: 'already_done' })
    expect(applyCheck(widgets, update, { id: 'r', values: { name: 'Nut', unitPrice: '0.250' } })).toEqual({ apply: true })
    expect(applyCheck(widgets, update, { id: 'r', values: { name: 'Nut (new)', unitPrice: '0.25' } })).toEqual({ apply: false, note: 'changed_since_dry_run' })
    expect(applyCheck(widgets, update, { id: 'r', values: { name: 'Nut M6', unitPrice: '0.3' } })).toEqual({ apply: false, note: 'already_done' })
    expect(applyCheck(widgets, update, { id: 'other', values: { name: 'Nut', unitPrice: '0.25' } })).toEqual({ apply: false, note: 'changed_since_dry_run' })
    expect(applyCheck(widgets, update, null)).toEqual({ apply: false, note: 'changed_since_dry_run' })
  })
})

describe('the job', () => {
  it('moves along its machine; an apply resumes only after a finished dry run', () => {
    expect(canTransition(importMachine, 'UPLOADED', 'PLANNED', { planned: false }).ok).toBe(true)
    expect(canTransition(importMachine, 'UPLOADED', 'APPLYING', { planned: false }).ok).toBe(false)
    expect(canTransition(importMachine, 'FAILED', 'APPLYING', { planned: true }).ok).toBe(true)
    expect(canTransition(importMachine, 'FAILED', 'APPLYING', { planned: false }).ok).toBe(false)
    expect(canTransition(importMachine, 'APPLIED', 'CANCELLED', { planned: true }).ok).toBe(false)
    expect(importMachine.finals).toEqual(['APPLIED', 'CANCELLED'])
  })

  it('takes CSV and xlsx, refuses macros and old Excel files with what to do', () => {
    expect(sheetTypeProblem('text/csv', 'clienti.csv')).toBeNull()
    expect(sheetTypeProblem('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'items.xlsx')).toBeNull()
    expect(sheetTypeProblem('application/vnd.ms-excel.sheet.macroEnabled.12', 'items.xlsm')).toMatch(/macros/)
    expect(sheetTypeProblem('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'items.xlsm')).toMatch(/macros/)
    expect(sheetTypeProblem('application/vnd.ms-excel', 'items.xls')).toMatch(/Old Excel/)
    expect(sheetTypeProblem('application/pdf', 'items.pdf')).toMatch(/Expected a .csv/)
  })
})
