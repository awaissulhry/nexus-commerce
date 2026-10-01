/**
 * The sheet's progress columns (2026-09-26) — the values both scopes feed the DS cell, and the links it offers.
 * Every number is the server's: a row's own `completeness`, or the readiness index for a coordinate.
 */
import { describe, expect, it } from 'vitest'
import { progressTone } from '@/design-system/grid'
import { coordinateProgressValue, isProgressColumn, listingsHref, progressColumn, rowProgressValue, sameProgressReading, sheetFieldAction, studioFieldHref, withoutProgressColumns } from './progressColumns'

const completeness = {
  overall: { filled: 5, total: 10, pct: 50 },
  required: { filled: 2, total: 3, missing: [{ key: 'brand', label: 'Brand' }] },
  optional: { filled: 3, total: 7, missing: [{ key: 'colour', label: 'Colour' }, { key: 'material', label: 'Material' }] },
}

describe('rowProgressValue — a sheet row in its own scope', () => {
  it('takes the counts and names from the row; an issue ON an empty field is its reason, not a second entry', () => {
    const v = rowProgressValue({ completeness, readiness: { issues: [
      { key: 'brand', label: 'Brand', message: 'Brand is required on Amazon.' },
      { key: 'ean', label: 'EAN', message: 'Not a valid EAN-13.' },
    ] } })!
    expect(v.pct).toBe(50)
    expect(v.requiredEmpty).toEqual([{ field: 'brand', label: 'Brand', reason: 'Brand is required on Amazon.' }])
    expect(v.optionalEmpty).toEqual([{ field: 'colour', label: 'Colour' }, { field: 'material', label: 'Material' }])
    expect(v.otherIssues).toEqual([{ field: 'ean', label: 'EAN', reason: 'Not a valid EAN-13.' }])
    expect(progressTone(v)).toBe('missing')
  })
  it('an older payload with no optional side is NOT RECORDED — grey once the required side is complete, never green', () => {
    const v = rowProgressValue({ completeness: { overall: completeness.overall, required: { filled: 3, total: 3, missing: [] } } })!
    expect(v.optional).toBeNull()
    expect(v.optionalEmpty).toBeNull()
    expect(progressTone(v)).toBe('unknown')
  })
  it('an unscorable scope withholds the percentage and says why', () => {
    const v = rowProgressValue({ completeness }, 'OUTERWEAR requirements on Amazon · BE are unavailable.')!
    expect(v.pct).toBeNull()
    expect(v.note).toBe('OUTERWEAR requirements on Amazon · BE are unavailable.')
    expect(progressTone(v)).toBe('unknown')
  })
  it('no completeness at all is no value', () => {
    expect(rowProgressValue({})).toBeNull()
  })
})

describe('coordinateProgressValue — a product at a channel coordinate, from the index', () => {
  const entries = [
    { field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true as const },
    { field: 'gtin', label: 'GTIN', reason: 'Not a valid GTIN' },
  ]
  it('combines both sides into one percentage and keeps the generic reason out of the card', () => {
    const v = coordinateProgressValue({ state: 'blocked', pct: 67, required: { filled: 2, total: 3 }, optional: { filled: 1, total: 3 } }, entries, [{ field: 'colour', label: 'Colour' }])!
    expect(v.pct).toBe(50)
    expect(v.requiredEmpty).toEqual([{ field: 'brand', label: 'Brand', reason: null }])
    expect(v.otherIssues).toEqual([{ field: 'gtin', label: 'GTIN', reason: 'Not a valid GTIN' }])
    expect(v.optionalEmpty).toEqual([{ field: 'colour', label: 'Colour' }])
  })
  it('no index row is not computed (null), never 0%', () => {
    expect(coordinateProgressValue(undefined, [], [])).toBeNull()
  })
  it('an unscorable coordinate carries the server note and no percentage', () => {
    const v = coordinateProgressValue({ state: 'absent', pct: null, note: 'Category metadata is incomplete' }, [], [])!
    expect(v.pct).toBeNull()
    expect(v.note).toBe('Category metadata is incomplete')
    expect(progressTone(v)).toBe('unknown')
  })
  it('an index row written before the optional columns is not recorded: no percentage, grey unless a required field is empty', () => {
    const v = coordinateProgressValue({ state: 'ready', pct: 100, required: { filled: 3, total: 3 } }, [], [])!
    expect(v.pct).toBeNull()
    expect(progressTone(v)).toBe('unknown')
    expect(progressTone(coordinateProgressValue({ state: 'blocked', pct: 67, required: { filled: 2, total: 3 } }, entries, [])!)).toBe('missing')
  })
})

describe('links and actions', () => {
  it('studioFieldHref patches only its keys: scope, market, locale, account, alias, rec, cell — and drops the tab', () => {
    const href = studioFieldHref({ pathname: '/w/ws/products/p/edit/studio', search: '?market=IT&tab=errors&chip=x' },
      { scope: 'AMAZON', market: 'IT', locale: 'it', accountId: 'acc', aliasId: null, rowId: 'primary:c1', field: 'brand' })
    const url = new URL(href, 'http://x')
    expect(url.pathname).toBe('/w/ws/products/p/edit/studio')
    expect(Object.fromEntries(url.searchParams)).toEqual({ market: 'IT', chip: 'x', scope: 'AMAZON', locale: 'it', account: 'acc', rec: 'primary:c1', cell: 'brand' })
  })
  it('listingsHref narrows the listings page to one channel · market · language; the shared product is SHARED', () => {
    expect(listingsHref({ channel: 'AMAZON', market: 'IT', language: 'it' }, null)).toBe('/products/listing-readiness?channel=AMAZON&marketplace=IT&language=it')
    expect(listingsHref({ channel: null, language: 'it' }, null)).toBe('/products/listing-readiness?channel=SHARED&language=it')
  })
  it('a field of this sheet: visible → Go to, hidden → Show and go to, absent → a sentence', () => {
    expect(sheetFieldAction('visible', 'Brand', 'x')).toEqual({ kind: 'goto', label: 'Go to' })
    expect(sheetFieldAction('hidden', 'Brand', 'x')).toEqual({ kind: 'goto', label: 'Show and go to' })
    expect(sheetFieldAction('absent', 'Brand', 'Not a column on this sheet')).toEqual({ kind: 'none', text: 'Not a column on this sheet' })
  })
  it('progress columns are recognised by id and kept out of the attribute builders', () => {
    expect(isProgressColumn('progress:scope')).toBe(true)
    expect(isProgressColumn('brand')).toBe(false)
    expect(withoutProgressColumns([{ key: 'a' }, { key: 'progress:scope', managedBy: 'progress' }])).toEqual([{ key: 'a' }])
  })
})

describe('progressColumn — repaints only what changed (2026-10-01 scroll/edit budgets)', () => {
  type Row = { sku: string; completeness: { overall: { filled: number; total: number; pct: number }; required: { filled: number; total: number; missing: Array<{ key: string; label: string }> } } }
  const column = progressColumn<Row>({ colId: 'progress:scope', headerName: 'Shared product', headerTooltip: '', value: row => rowProgressValue(row),
    cell: { scopeLabel: 'Shared product', subjectOf: p => (p.data as Row | undefined)?.sku ?? null, actionFor: () => ({ kind: 'none', reason: '' }) as never, onGoTo: () => {} } })
  const row = (over: Partial<Row> = {}): Row => ({ sku: 'E2E-A', completeness: { overall: { filled: 3, total: 4, pct: 75 }, required: { filled: 1, total: 2, missing: [{ key: 'brand', label: 'Brand' }] } }, ...over })
  const read = (data: Row) => (column.valueGetter as (p: { data: Row }) => unknown)({ data })
  const equals = column.equals!

  it('treats a reading rebuilt from the same facts as unchanged, though it is a new object', () => {
    const a = read(row()), b = read(row())
    expect(a).not.toBe(b)
    expect(equals(a, b)).toBe(true)
  })

  it('repaints when the percentage, an empty field or the named row changes', () => {
    const base = read(row())
    expect(equals(base, read(row({ completeness: { ...row().completeness, overall: { filled: 4, total: 4, pct: 100 } } })))).toBe(false)
    expect(equals(base, read(row({ completeness: { ...row().completeness, required: { filled: 1, total: 2, missing: [{ key: 'colour', label: 'Colour' }] } } })))).toBe(false)
    expect(equals(base, read(row({ sku: 'E2E-B' })))).toBe(false)
    expect(equals(base, null)).toBe(false)
  })

  it('still formats the reading as before', () => {
    expect(sameProgressReading(null, undefined)).toBe(true)
    const formatted = (column.valueFormatter as (p: { data: Row; value: unknown }) => string)({ data: row(), value: read(row()) })
    expect(formatted).toMatch(/75/)
  })
})
