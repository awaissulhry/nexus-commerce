import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CASE_COPY } from '@nexus/shared/stock-cases'

import {
  blankSize, CASE_DIALOG_COPY, CASE_KEEP, CASE_MIXED, caseBoxWarning, caseCellView, caseSaveHeld, caseSavedSentence, caseStart, caseTooltip, caseWrites,
  packValues, parseCaseNumber, parseSizes, putCasePacks, saveLabel, sealedSummary, sizeFieldProblem, undoWrites, type CaseDraft, type CaseMember, type SizeDraft,
} from './casePack'
import { buildMatrixColumns, CASE_COL, caseViewOf, FBA_COL, STOCK_COL } from './columns'
import type { MatrixCasePack, MatrixCaseSize, MatrixRowRead } from './contract'
import { parseMatrixRead } from './source'
import { MATRIX_CASE_SINCE, savedBeforeMatrixCase } from './statusCells'

/**
 * The Matrix Case column (Step 3 part D, Owner 2026-10-07; several case sizes per SKU, Owner 2026-10-08): Base price ·
 * Stock · Case · FBA qty; "12 / case" or "12 · 6 / case", blank when not set, the parent "Mixed" when its variants
 * differ; the pop-up's values, checks, family writes and the route's client; and the saved-view rule that keeps older
 * views showing it.
 */

const size = (over: Partial<MatrixCaseSize> = {}): MatrixCaseSize => ({ unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, ...over })
const SIX = size({ unitsPerCase: 6, caseLengthCm: 40, caseWidthCm: 30, caseHeightCm: 35, caseWeightKg: 7.5 })
const pack = (over: Partial<MatrixCasePack> = {}): MatrixCasePack => ({ sizes: [size()], fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER', ...over })
const row = (id: string, p: MatrixCasePack | null | undefined, role: MatrixRowRead['role'] = 'variant'): MatrixRowRead => ({
  id, sku: id.toUpperCase(), role, stock: { available: 4, uncounted: false, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {},
  ...(p === undefined ? {} : { pack: p }),
})

describe('the Case cell', () => {
  it('a variant shows "12 / case" or "12 · 6 / case"; blank when not set; an older server (no pack) shows blank and opens nothing', () => {
    expect(caseCellView(row('a', pack()))).toMatchObject({ text: '12 / case', value: 12, look: 'set', door: true })
    expect(caseCellView(row('a2', pack({ sizes: [SIX, size()] })))).toMatchObject({ text: '12 · 6 / case', value: 12, look: 'set' })
    expect(caseCellView(row('b', null))).toMatchObject({ text: '', value: null, look: 'none', door: true })
    expect(caseCellView(row('c', pack({ sizes: [] })))).toMatchObject({ text: '', value: null, door: true })
    expect(caseCellView(row('d', undefined))).toMatchObject({ text: '', value: null, door: false, tooltip: undefined })
  })

  it('the parent shows its variants\' one list, "Mixed" when they differ, blank when none has one', () => {
    const parent = row('p', null, 'parent')
    expect(caseCellView(parent, [row('a', pack()), row('b', pack())])).toMatchObject({ text: '12 / case', value: 12, look: 'set', door: true })
    expect(caseCellView(parent, [row('a', pack()), row('b', pack({ sizes: [SIX] }))])).toMatchObject({ text: CASE_MIXED, value: null, look: 'mixed', door: true })
    expect(caseCellView(parent, [row('a', pack()), row('b', pack({ sizes: [size(), SIX] }))])).toMatchObject({ text: CASE_MIXED, look: 'mixed' })
    expect(caseCellView(parent, [row('a', pack()), row('b', null)])).toMatchObject({ text: CASE_MIXED, look: 'mixed' })
    expect(caseCellView(parent, [row('a', null), row('b', null)])).toMatchObject({ text: '', value: null, look: 'none', door: true })
    expect(caseCellView(parent, [])).toMatchObject({ door: false })
  })

  it('tooltips: one line per size (size, box, weight), then prep and labels; the parent lists the size lists when they differ', () => {
    expect(caseTooltip(pack())).toBe('12 per case · 60 × 40 × 35 cm · 14.5 kg\nPrep: Seller · Labels: Seller')
    expect(caseTooltip(pack({ sizes: [SIX, size()] }))).toBe('12 per case · 60 × 40 × 35 cm · 14.5 kg\n6 per case · 40 × 30 × 35 cm · 7.5 kg\nPrep: Seller · Labels: Seller')
    expect(caseTooltip(pack({ sizes: [size({ caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null })], fbaLabelOwner: null, fbaPrepOwner: 'AMAZON' }))).toBe('12 per case\nPrep: Amazon')
    expect(caseTooltip(null)).toBe('No case size')
    const mixed = caseCellView(row('p', null, 'parent'), [row('a', pack()), row('b', pack()), row('c', pack({ sizes: [SIX] })), row('e', pack({ sizes: [size(), SIX] })), row('d', null)])
    expect(mixed.tooltip).toBe(`${CASE_MIXED}\n6 / case · 1 variant\n12 / case · 2 variants\n12 · 6 / case · 1 variant\nNot set · 1 variant`)
    // Same sizes, different boxes: the one list for all.
    expect(caseCellView(row('p', null, 'parent'), [row('a', pack()), row('b', pack({ sizes: [size({ caseWeightKg: 9 })] }))]).tooltip).toBe('All 2 variants: 12 / case')
  })

  it('a pack that arrived with Decimal strings reads as numbers; sizes biggest first; a size without units is dropped', () => {
    const v = packValues({ ...pack(), sizes: [SIX, { ...size(), caseLengthCm: '60.0' as never, caseWeightKg: '14.50' as never }, { ...size(), unitsPerCase: 0 }] })
    expect(v.sizes.map((s) => s.unitsPerCase)).toEqual([12, 6])
    expect(v.sizes[0]).toMatchObject({ caseLengthCm: 60, caseWeightKg: 14.5 })
  })
})

type Def = Record<string, unknown>
const ROWS: Record<string, MatrixRowRead> = { p: row('p', null, 'parent'), a: row('a', pack()), b: row('b', pack({ sizes: [SIX] })), old: row('old', undefined) }
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
const typed = (over: Partial<SizeDraft>): SizeDraft => ({ ...blankSize(), ...over })
const plain = (rows: SizeDraft[] | null) => rows?.map(({ key: _key, ...r }) => r) ?? null
const S12 = { unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5 }
const S6 = { unitsPerCase: 6, caseLengthCm: 40, caseWidthCm: 30, caseHeightCm: 35, caseWeightKg: 7.5 }

describe('the Case pop-up', () => {
  it('starts from the sizes (one row each, biggest first) and the owners; no size → one blank row', () => {
    const one = caseStart([M('a', pack({ sizes: [SIX, size()] }))])
    expect(plain(one.draft.sizes)).toEqual([
      { unitsPerCase: '12', caseLengthCm: '60', caseWidthCm: '40', caseHeightCm: '35', caseWeightKg: '14.5' },
      { unitsPerCase: '6', caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '35', caseWeightKg: '7.5' },
    ])
    expect(one.draft.fbaPrepOwner).toBe('SELLER')
    expect(one.mixed.size).toBe(0)
    expect(plain(caseStart([M('b', null)]).draft.sizes)).toEqual([{ unitsPerCase: '', caseLengthCm: '', caseWidthCm: '', caseHeightCm: '', caseWeightKg: '' }])
  })

  it('a family whose sizes differ starts as "keep" (null), with the first variant\'s list ready for "Replace for all"', () => {
    const fam = caseStart([M('a', pack()), M('b', pack({ sizes: [SIX], fbaPrepOwner: null }))])
    expect(fam.draft.sizes).toBeNull()
    expect(fam.draft.fbaPrepOwner).toBe(CASE_KEEP)
    expect(fam.draft.fbaLabelOwner).toBe('SELLER')
    expect([...fam.mixed].sort()).toEqual(['fbaPrepOwner', 'sizes'])
    expect(plain(fam.firstSizes)?.map((r) => r.unitsPerCase)).toEqual(['12'])
  })

  it('numbers: empty = not set, a comma is the decimal point, text is refused with the shared sentence', () => {
    expect(parseCaseNumber('')).toBeNull()
    expect(parseCaseNumber('35,5')).toBe(35.5)
    expect(parseCaseNumber('abc')).toBeNaN()
    expect(sizeFieldProblem('unitsPerCase', '12')).toBeNull()
    expect(sizeFieldProblem('unitsPerCase', '0')).toMatch(/whole number from 1 to 10000/)
    expect(sizeFieldProblem('unitsPerCase', '2.5')).toMatch(/whole number/)
    expect(sizeFieldProblem('caseLengthCm', '301')).toMatch(/at most 300 cm/)
    expect(sizeFieldProblem('caseWeightKg', 'x')).toBe('Enter a number')
  })

  it('the list: a blank row is left out; a row needs its units; units may not repeat; biggest first', () => {
    const a = typed({ unitsPerCase: '6', caseWeightKg: '7,5' })
    const b = typed({ unitsPerCase: '12' })
    expect(parseSizes([a, typed({}), b])).toMatchObject({ values: [{ unitsPerCase: 12 }, { unitsPerCase: 6, caseWeightKg: 7.5 }], first: null })
    const noUnits = typed({ caseLengthCm: '40' })
    expect(parseSizes([noUnits]).problems.get(`${noUnits.key}:unitsPerCase`)).toBe(CASE_DIALOG_COPY.needUnits)
    const twice = typed({ unitsPerCase: '12' })
    expect(parseSizes([b, twice]).problems.get(`${twice.key}:unitsPerCase`)).toBe(CASE_COPY.sameSize(12))
  })

  it('a variant: one write of its sizes; nothing changed → nothing to save; a bad field holds Save', () => {
    const members = [M('a', null)]
    const start = caseStart(members)
    expect(caseSaveHeld(members, start.draft, start)).toBe('')
    const draft: CaseDraft = { ...start.draft, sizes: [typed({ unitsPerCase: '12', caseLengthCm: '60', caseWidthCm: '40', caseHeightCm: '35', caseWeightKg: '14,5' })], fbaPrepOwner: 'SELLER' }
    expect(caseSaveHeld(members, draft, start)).toBeNull()
    expect(caseWrites(members, draft, start)).toEqual([{ productIds: ['a'], values: { sizes: [S12], fbaPrepOwner: 'SELLER' } }])
    expect(caseSaveHeld(members, { ...draft, sizes: [typed({ unitsPerCase: '0' })] }, start)).toMatch(/whole number/)
  })

  it('adding a second size sends the whole list; removing every size sends []; owners only send no sizes', () => {
    const members = [M('a', pack())]
    const start = caseStart(members)
    const two: CaseDraft = { ...start.draft, sizes: [...start.draft.sizes!, typed({ unitsPerCase: '6', caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '35', caseWeightKg: '7.5' })] }
    expect(caseWrites(members, two, start)).toEqual([{ productIds: ['a'], values: { sizes: [S12, S6] } }])
    expect(caseWrites(members, { ...start.draft, sizes: [] }, start)).toEqual([{ productIds: ['a'], values: { sizes: [] } }])
    expect(caseWrites(members, { ...start.draft, fbaLabelOwner: 'AMAZON' }, start)).toEqual([{ productIds: ['a'], values: { fbaLabelOwner: 'AMAZON' } }])
    expect(caseWrites(members, { ...start.draft, fbaLabelOwner: '' }, start)).toEqual([{ productIds: ['a'], values: { fbaLabelOwner: null } }])
  })

  it('the parent: sizes untouched keep each variant\'s own; "Replace for all" writes one list to every variant that differs', () => {
    const members = [M('a', pack()), M('b', pack({ sizes: [SIX] })), M('c', pack())]
    const start = caseStart(members)
    // Only the label owner changes: no sizes in the write.
    const owners = caseWrites(members, { ...start.draft, fbaLabelOwner: 'AMAZON' }, start)
    expect(owners).toEqual([{ productIds: ['a', 'b', 'c'], values: { fbaLabelOwner: 'AMAZON' } }])
    // Replace for all, starting from the first variant's list (12 / case): b changes, a and c already hold it.
    const replace = caseWrites(members, { ...start.draft, sizes: start.firstSizes }, start)
    expect(replace).toEqual([{ productIds: ['b'], values: { sizes: [S12] } }])
    // Undo: each variant back to what it held, for what was written.
    expect(undoWrites(members, [...owners, ...replace])).toEqual([
      { productIds: ['a', 'c'], values: { fbaLabelOwner: 'SELLER' } },
      { productIds: ['b'], values: { sizes: [S6], fbaLabelOwner: 'SELLER' } },
    ])
  })

  it('Amazon EU box limits are a warning only: 70 cm or 24 kg warns, 63.5 cm and 23 kg do not', () => {
    const members = [M('a', null)]
    const start = caseStart(members)
    const at = (over: Partial<SizeDraft>): CaseDraft => ({ ...start.draft, sizes: [typed({ unitsPerCase: '6', ...over })] })
    expect(caseBoxWarning(members, at({ caseLengthCm: '70' }))).toBe(CASE_COPY.boxLimit)
    expect(caseBoxWarning(members, at({ caseWeightKg: '24' }))).toBe(CASE_COPY.boxLimit)
    expect(caseBoxWarning(members, at({ caseLengthCm: '63.5', caseWeightKg: '23' }))).toBeNull()
    expect(caseSaveHeld(members, at({ caseLengthCm: '70' }), start)).toBeNull()
    // Sizes kept per variant: the variants' own sizes are checked.
    expect(caseBoxWarning([M('b', pack({ sizes: [size({ caseWeightKg: 30 })] }))], { sizes: null, fbaPrepOwner: '', fbaLabelOwner: '' })).toBe(CASE_COPY.boxLimit)
  })

  it('a 409 SEALED_CASES: one sentence and "Save · open N cases"', () => {
    const s = sealedSummary([{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', unitsPerCase: 6, cases: 3 }, { productId: 'b', sku: 'B', locationCode: 'IT-MAIN', unitsPerCase: 6, cases: 1 }])
    expect(s).toEqual({ cases: 4, sentence: CASE_COPY.sealedOpen(4, 'IT-MAIN') })
    expect(saveLabel(4, true)).toBe('Save · open 4 cases')
    expect(saveLabel(1, true)).toBe('Save · open 1 case')
    expect(saveLabel(null, false)).toBe('Save')
    expect(sealedSummary([])).toBeNull()
  })

  it('the toast names the SKU, the sizes, and cases opened', () => {
    expect(caseSavedSentence('GALE-M', [{ productIds: ['a'], values: { sizes: [S12, S6] } }], 0)).toBe('Case saved · GALE-M · 12 · 6 / case')
    expect(caseSavedSentence('All 3 variants', [{ productIds: ['a'], values: { sizes: [S12] } }], 2)).toBe('Case saved · All 3 variants · 12 / case · 2 cases opened')
    expect(caseSavedSentence('GALE-M', [{ productIds: ['a'], values: { sizes: [] } }], 0)).toBe('Case saved · GALE-M · No case size')
    expect(caseSavedSentence('GALE-M', [{ productIds: ['a'], values: { fbaPrepOwner: 'AMAZON' } }], 0)).toBe('Case saved · GALE-M')
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
  const write = { productIds: ['a', 'b'], values: { sizes: [S12], fbaPrepOwner: 'SELLER' as const } }

  it('sends the SKUs and the values set (sizes, owners); openSealedCases only on the confirm', async () => {
    const f = fake(200, { ok: true, results: [{ productId: 'a', ok: true }, { productId: 'b', ok: true, noop: true }] })
    const a = await putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })
    expect(f.calls[0]!.url).toBe('http://api/api/stock/case-packs')
    expect(f.calls[0]!.init.method).toBe('PUT')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ productIds: ['a', 'b'], sizes: [S12], fbaPrepOwner: 'SELLER' })
    expect(a).toEqual({ kind: 'saved', results: [{ productId: 'a', ok: true }, { productId: 'b', ok: true, noop: true }] })
    await putCasePacks(write, true, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })
    expect(JSON.parse(String(f.calls[1]!.init.body)).openSealedCases).toBe(true)
  })

  it('409 SEALED_CASES → the levels whose cases would open', async () => {
    const f = fake(409, { code: 'SEALED_CASES', sealed: [{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', unitsPerCase: 6, cases: 4 }] })
    expect(await putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })).toEqual({ kind: 'sealed', sealed: [{ productId: 'a', sku: 'A', locationCode: 'IT-MAIN', unitsPerCase: 6, cases: 4 }] })
  })

  it('a 400 throws the server\'s sentence', async () => {
    const f = fake(400, { error: 'Units per case must be a whole number from 1 to 10000' })
    await expect(putCasePacks(write, false, { fetchImpl: f.fetchImpl, baseUrl: 'http://api' })).rejects.toThrow('Units per case must be a whole number from 1 to 10000')
  })
})

describe('the Matrix read carries each row\'s case pack', () => {
  it('a pack (sizes biggest first, Decimal strings read as numbers), null = none set, absent = an older server', () => {
    const body = { coordinates: [], rows: [
      { id: 'a', pack: { sizes: [{ unitsPerCase: 6 }, { unitsPerCase: 12, caseLengthCm: '60.0', caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: '14.50' }, { unitsPerCase: 0 }], fbaPrepOwner: 'SELLER', fbaLabelOwner: 'NONE' } },
      { id: 'b', pack: null },
      { id: 'c' },
    ] }
    const r = parseMatrixRead(body, 'p')
    const rows = 'read' in r ? r.read.rows : []
    expect(rows[0]!.pack).toEqual({
      sizes: [
        { unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5 },
        { unitsPerCase: 6, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null },
      ],
      fbaPrepOwner: 'SELLER', fbaLabelOwner: null,
    })
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
