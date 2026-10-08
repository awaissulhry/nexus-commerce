import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CASE_COPY } from '@nexus/shared/stock-cases'

import {
  CASE_KEEP, CASE_MIXED, caseBoxWarning, caseCellView, caseFieldProblem, caseSaveHeld, caseSavedSentence, caseStart, caseTooltip, caseWrites, packValues,
  parseCaseNumber, putCasePacks, saveLabel, sealedSummary, undoWrites, type CaseMember,
} from './casePack'
import { buildMatrixColumns, CASE_COL, caseViewOf, FBA_COL, STOCK_COL } from './columns'
import type { MatrixCasePack, MatrixRowRead } from './contract'
import { parseMatrixRead } from './source'
import { MATRIX_CASE_SINCE, savedBeforeMatrixCase } from './statusCells'

/**
 * The Matrix Case column (Step 3 part D, Owner 2026-10-07): Base price · Stock · Case · FBA qty; "12 / case", blank when
 * not set, the parent "Mixed" when its variants differ; the pop-up's values, checks, family writes and the route's client;
 * and the saved-view rule that keeps older views showing it.
 */

const pack = (over: Partial<MatrixCasePack> = {}): MatrixCasePack => ({
  unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER', ...over,
})
const row = (id: string, p: MatrixCasePack | null | undefined, role: MatrixRowRead['role'] = 'variant'): MatrixRowRead => ({
  id, sku: id.toUpperCase(), role, stock: { available: 4, uncounted: false, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {},
  ...(p === undefined ? {} : { pack: p }),
})

describe('the Case cell', () => {
  it('a variant shows "12 / case"; blank when not set; an older server (no pack) shows blank and opens nothing', () => {
    expect(caseCellView(row('a', pack()))).toMatchObject({ text: '12 / case', value: 12, look: 'set', door: true })
    expect(caseCellView(row('b', null))).toMatchObject({ text: '', value: null, look: 'none', door: true })
    expect(caseCellView(row('c', pack({ unitsPerCase: null })))).toMatchObject({ text: '', value: null, door: true })
    expect(caseCellView(row('d', undefined))).toMatchObject({ text: '', value: null, door: false, tooltip: undefined })
  })

  it('the parent shows its variants\' one size, "Mixed" when they differ, blank when none has one', () => {
    const parent = row('p', null, 'parent')
    expect(caseCellView(parent, [row('a', pack()), row('b', pack())])).toMatchObject({ text: '12 / case', value: 12, look: 'set', door: true })
    expect(caseCellView(parent, [row('a', pack()), row('b', pack({ unitsPerCase: 6 }))])).toMatchObject({ text: CASE_MIXED, value: null, look: 'mixed', door: true })
    expect(caseCellView(parent, [row('a', pack()), row('b', null)])).toMatchObject({ text: CASE_MIXED, look: 'mixed' })
    expect(caseCellView(parent, [row('a', null), row('b', null)])).toMatchObject({ text: '', value: null, look: 'none', door: true })
    expect(caseCellView(parent, [])).toMatchObject({ door: false })
  })

  it('tooltips: size, box and weight, then prep and labels; the parent lists the sizes when they differ', () => {
    expect(caseTooltip(pack())).toBe('12 per case · 60 × 40 × 35 cm · 14.5 kg\nPrep: Seller · Labels: Seller')
    expect(caseTooltip(pack({ caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaLabelOwner: null, fbaPrepOwner: 'AMAZON' }))).toBe('12 per case\nPrep: Amazon')
    expect(caseTooltip(null)).toBe('No case size')
    const mixed = caseCellView(row('p', null, 'parent'), [row('a', pack()), row('b', pack()), row('c', pack({ unitsPerCase: 6 })), row('d', null)])
    expect(mixed.tooltip).toBe(`${CASE_MIXED}\n6 / case · 1 variant\n12 / case · 2 variants\nNot set · 1 variant`)
    // Same size, different boxes: the one size for all.
    expect(caseCellView(row('p', null, 'parent'), [row('a', pack()), row('b', pack({ caseWeightKg: 9 }))]).tooltip).toBe('All 2 variants: 12 / case')
  })

  it('a pack that arrived with Decimal strings reads as numbers', () => {
    expect(packValues({ ...pack(), caseLengthCm: '60.0' as never, caseWeightKg: '14.50' as never })).toMatchObject({ caseLengthCm: 60, caseWeightKg: 14.5 })
  })
})

type Def = Record<string, unknown>
const ROWS: Record<string, MatrixRowRead> = { p: row('p', null, 'parent'), a: row('a', pack()), b: row('b', pack({ unitsPerCase: 6 })), old: row('old', undefined) }
function shared(onOpenCase?: (rowId: string, anchor: HTMLElement | null) => void): Def[] {
  const defs = buildMatrixColumns({
    coordinates: [], cellsOf: () => null, rowOf: (id: string) => ROWS[id] ?? null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined,
    rowsRef: { current: [{ id: 'p' }, { id: 'a' }, { id: 'b' }] }, onOpenCase,
  } as never) as Def[]
  return defs.find((g) => g.groupId === 'grp-shared')!.children as Def[]
}
const caseDef = (door?: (rowId: string, anchor: HTMLElement | null) => void) => shared(door).find((d) => d.colId === CASE_COL)!
const render = (d: Def, id: string) => {
  const params = { ...(d.cellRendererParams as object), data: { id }, node: { rowIndex: 0 }, api: {}, column: { getColId: () => CASE_COL } }
  return renderToStaticMarkup(createElement(d.cellRenderer as never, params as never))
}
const call = <T,>(fn: unknown, params: unknown): T => (fn as (p: unknown) => T)(params)

describe('the Case column on the Matrix', () => {
  it('sits in the Shared group: Base price · Stock · Case · FBA qty, headed "Case" with a short tooltip', () => {
    expect(shared().map((d) => d.colId)).toEqual(['basePrice', STOCK_COL, CASE_COL, FBA_COL])
    const d = caseDef()
    expect(d.headerName).toBe('Case')
    expect(String(d.headerTooltip).length).toBeLessThan(100)
  })

  it('is read-only in its definition — the pop-up is its only writer', () => {
    const d = caseDef()
    expect(d.editable).toBe(false)
    expect(d.suppressFillHandle).toBe(true)
    expect(d.suppressPaste).toBe(true)
    expect(d.cellEditor).toBeUndefined()
  })

  it('sort, copy and export read the number; the cell reads "12 / case", the parent "Mixed"', () => {
    const d = caseDef()
    expect(call(d.valueGetter, { data: { id: 'a' } })).toBe(12)
    expect(call(d.valueGetter, { data: { id: 'p' } })).toBeNull()
    expect(render(d, 'a')).toContain('>12 / case<')
    expect(render(d, 'p')).toContain(`>${CASE_MIXED}<`)
    expect(call(d.tooltipValueGetter, { data: { id: 'a' } })).toContain('12 per case')
    expect(caseViewOf('p', (id) => ROWS[id] ?? null, [{ id: 'p' }, { id: 'a' }, { id: 'b' }]).look).toBe('mixed')
  })

  it('the pencil only when the page gives a door and the server reads case packs', () => {
    expect(render(caseDef(() => undefined), 'a').match(/data-nds-cell-action/g)?.length).toBe(1)
    expect(render(caseDef(() => undefined), 'p')).toContain('data-nds-cell-action')
    expect(render(caseDef(undefined), 'a')).not.toContain('data-nds-cell-action')
    expect(render(caseDef(() => undefined), 'old')).not.toContain('data-nds-cell-action')
    expect(caseDef().cellClass).toContain('nds-reveal-row')
  })
})

const M = (id: string, p: MatrixCasePack | null): CaseMember => ({ id, sku: id.toUpperCase(), pack: p })

describe('the Case pop-up', () => {
  it('starts from the values; a field the variants differ on starts as "keep"', () => {
    const one = caseStart([M('a', pack())])
    expect(one.draft).toEqual({ unitsPerCase: '12', caseLengthCm: '60', caseWidthCm: '40', caseHeightCm: '35', caseWeightKg: '14.5', fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' })
    expect(one.mixed.size).toBe(0)
    const fam = caseStart([M('a', pack()), M('b', pack({ unitsPerCase: 6, fbaPrepOwner: null }))])
    expect(fam.draft.unitsPerCase).toBe(CASE_KEEP)
    expect(fam.draft.fbaPrepOwner).toBe(CASE_KEEP)
    expect(fam.draft.caseLengthCm).toBe('60')
    expect([...fam.mixed].sort()).toEqual(['fbaPrepOwner', 'unitsPerCase'])
  })

  it('numbers: empty = not set, a comma is the decimal point, text is refused with the shared sentence', () => {
    expect(parseCaseNumber('')).toBeNull()
    expect(parseCaseNumber('35,5')).toBe(35.5)
    expect(parseCaseNumber('abc')).toBeNaN()
    expect(caseFieldProblem('unitsPerCase', '12')).toBeNull()
    expect(caseFieldProblem('unitsPerCase', '')).toBeNull()
    expect(caseFieldProblem('unitsPerCase', '0')).toMatch(/whole number from 1 to 10000/)
    expect(caseFieldProblem('unitsPerCase', '2.5')).toMatch(/whole number/)
    expect(caseFieldProblem('caseLengthCm', '301')).toMatch(/at most 300 cm/)
    expect(caseFieldProblem('caseWeightKg', 'x')).toBe('Enter a number')
    expect(caseFieldProblem('caseWeightKg', CASE_KEEP)).toBeNull()
  })

  it('a variant: one write of all its values; nothing changed → nothing to save', () => {
    const members = [M('a', null)]
    const start = caseStart(members)
    expect(caseSaveHeld(members, start.draft, start)).toBe('')
    const draft = { ...start.draft, unitsPerCase: '12', caseLengthCm: '60', caseWidthCm: '40', caseHeightCm: '35', caseWeightKg: '14,5', fbaPrepOwner: 'SELLER' }
    expect(caseSaveHeld(members, draft, start)).toBeNull()
    expect(caseWrites(members, draft, start)).toEqual([{ productIds: ['a'], values: { unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, fbaPrepOwner: 'SELLER', fbaLabelOwner: null } }])
    expect(caseSaveHeld(members, { ...draft, unitsPerCase: '0' }, start)).toMatch(/whole number/)
  })

  it('clearing a value writes null (the case size is removed)', () => {
    const members = [M('a', pack())]
    const start = caseStart(members)
    expect(caseWrites(members, { ...start.draft, unitsPerCase: '' }, start)).toEqual([{ productIds: ['a'], values: { ...packValues(pack()), unitsPerCase: null } }])
  })

  it('the parent: one save for every variant; a mixed field left as it was keeps each variant\'s own (grouped writes)', () => {
    const members = [M('a', pack()), M('b', pack({ unitsPerCase: 6 })), M('c', pack())]
    const start = caseStart(members)
    // Only the label owner changes: units stay 12 / 6 / 12 — two writes, grouped by their values.
    const writes = caseWrites(members, { ...start.draft, fbaLabelOwner: 'AMAZON' }, start)
    expect(writes).toEqual([
      { productIds: ['a', 'c'], values: { ...packValues(pack()), fbaLabelOwner: 'AMAZON' } },
      { productIds: ['b'], values: { ...packValues(pack({ unitsPerCase: 6 })), fbaLabelOwner: 'AMAZON' } },
    ])
    // Typing a size sets it for all: one write.
    expect(caseWrites(members, { ...start.draft, unitsPerCase: '24' }, start)).toEqual([{ productIds: ['a', 'b', 'c'], values: { ...packValues(pack()), unitsPerCase: 24 } }])
    // A variant already at the new value is left out.
    expect(caseWrites(members, { ...start.draft, unitsPerCase: '6' }, start)).toEqual([{ productIds: ['a', 'c'], values: { ...packValues(pack()), unitsPerCase: 6 } }])
    // Undo: each variant back to what it held.
    expect(undoWrites(members, writes)).toEqual([
      { productIds: ['a', 'c'], values: packValues(pack()) },
      { productIds: ['b'], values: packValues(pack({ unitsPerCase: 6 })) },
    ])
  })

  it('Amazon EU box limits are a warning only: 70 cm or 24 kg warns, 63.5 cm and 23 kg do not', () => {
    const members = [M('a', null)]
    const start = caseStart(members)
    expect(caseBoxWarning(members, { ...start.draft, caseLengthCm: '70' }, start)).toBe(CASE_COPY.boxLimit)
    expect(caseBoxWarning(members, { ...start.draft, caseWeightKg: '24' }, start)).toBe(CASE_COPY.boxLimit)
    expect(caseBoxWarning(members, { ...start.draft, caseLengthCm: '63.5', caseWeightKg: '23' }, start)).toBeNull()
    expect(caseSaveHeld(members, { ...start.draft, caseLengthCm: '70' }, start)).toBeNull()
  })

  it('a 409 SEALED_CASES: one sentence and "Save · open N cases"', () => {
    const s = sealedSummary([{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', cases: 3 }, { productId: 'b', sku: 'B', locationCode: 'IT-MAIN', cases: 1 }])
    expect(s).toEqual({ cases: 4, sentence: CASE_COPY.sealedOpen(4, 'IT-MAIN') })
    expect(saveLabel(4, true)).toBe('Save · open 4 cases')
    expect(saveLabel(1, true)).toBe('Save · open 1 case')
    expect(saveLabel(null, false)).toBe('Save')
    expect(sealedSummary([])).toBeNull()
  })

  it('the toast names the SKU, the size, and cases opened', () => {
    const w = [{ productIds: ['a'], values: packValues(pack()) }]
    expect(caseSavedSentence('GALE-M', w, 0)).toBe('Case saved · GALE-M · 12 / case')
    expect(caseSavedSentence('All 3 variants', w, 2)).toBe('Case saved · All 3 variants · 12 / case · 2 cases opened')
  })
})

describe('PUT /api/stock/case-packs', () => {
  const fake = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }
  const write = { productIds: ['a', 'b'], values: packValues(pack()) }

  it('sends the SKUs and every value absolute; openSealedCases only on the confirm', async () => {
    const f = fake(200, { ok: true, results: [{ productId: 'a', ok: true }, { productId: 'b', ok: true, noop: true }] })
    const a = await putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })
    expect(f.calls[0]!.url).toBe('http://api/api/stock/case-packs')
    expect(f.calls[0]!.init.method).toBe('PUT')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ productIds: ['a', 'b'], ...packValues(pack()) })
    expect(a).toEqual({ kind: 'saved', results: [{ productId: 'a', ok: true }, { productId: 'b', ok: true, noop: true }] })
    await putCasePacks(write, true, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })
    expect(JSON.parse(String(f.calls[1]!.init.body)).openSealedCases).toBe(true)
  })

  it('409 SEALED_CASES → the levels whose cases would open', async () => {
    const f = fake(409, { code: 'SEALED_CASES', sealed: [{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', cases: 4 }] })
    expect(await putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })).toEqual({ kind: 'sealed', sealed: [{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', cases: 4 }] })
  })

  it('a 400 throws the server\'s sentence', async () => {
    const f = fake(400, { error: 'Units per case must be a whole number from 1 to 10000' })
    await expect(putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })).rejects.toThrow('Units per case must be a whole number from 1 to 10000')
  })
})

describe('the Matrix read carries each row\'s case pack', () => {
  it('a pack (Decimal strings read as numbers), null = none set, absent = an older server', () => {
    const body = { coordinates: [], rows: [
      { id: 'a', pack: { unitsPerCase: 12, caseLengthCm: '60.0', caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: '14.50', fbaPrepOwner: 'SELLER', fbaLabelOwner: 'NONE' } },
      { id: 'b', pack: null },
      { id: 'c' },
    ] }
    const r = parseMatrixRead(body, 'p')
    const rows = 'read' in r ? r.read.rows : []
    expect(rows[0]!.pack).toEqual({ unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, fbaPrepOwner: 'SELLER', fbaLabelOwner: null })
    expect(rows[1]!.pack).toBeNull()
    expect(rows[2]!.pack).toBeUndefined()
  })
})

describe('saved views keep showing Case', () => {
  it('a view saved before the Case column shows it wherever it shows Stock (the From rule\'s twin)', () => {
    expect(savedBeforeMatrixCase(new Date(MATRIX_CASE_SINCE - 1).toISOString())).toBe(true)
    expect(savedBeforeMatrixCase(new Date(MATRIX_CASE_SINCE + 1).toISOString())).toBe(false)
    expect(savedBeforeMatrixCase(undefined)).toBe(false)
    expect(savedBeforeMatrixCase('not a date')).toBe(false)
  })
})
