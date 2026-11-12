import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { readScan } from '../../scan/scan-model'
import { countProblemOf } from './api'
import { designScreen } from './fixtures'
import { binCounted, binOfCode, differenceRows, knownRefusal, lineTally, openBins, padBounds, padLines, passOf, quantityText, unitOfScan, unitsScanned, withLine, type BinLine, type BinRead, type Difference, type ToCount } from './model'

/** SCR-178 Count (B-W2b-310): the rules without a screen, and how the API's refusals read. Made-up bins, hides and lots. */

const count = { id: 'cnt-1', number: 'CNT-1', kind: 'CYCLE', status: 'COUNTING', freezeMoves: true }
const place = { id: 'loc-1', code: 'A1-STORE-01', name: 'Store 1', labelCode: 'BIN-A1-STORE-01' }
const line = (seq: number, extra: Partial<BinLine>): BinLine => ({
  lineId: `ln-${seq}`,
  seq,
  origin: 'SNAPSHOT',
  item: { id: 'i', code: 'PEL', name: 'Leather', uom: 'FT2', tracking: 'HIDE' },
  lot: { id: 'lot-7', code: 'LOT-7' },
  hide: null,
  pass: 'COUNT',
  scans: 0,
  scanned: '0.0000',
  ...extra,
})
const bin = (lines: BinLine[]): BinRead => ({ location: place, counts: [count], count, lines })
const HIDE_LINE = line(10, { hide: { id: 'h-1', code: 'HD-AAA-1' }, scans: 1, scanned: '52.4000' })
const LOT_LINE = line(20, { item: { id: 'l', code: 'FOD', name: 'Lining', uom: 'M', tracking: 'LOT' }, lot: { id: 'lot-31', code: 'LOT-31' } })
const PCS_LINE = line(30, { item: { id: 'b', code: 'FIB', name: 'Buckle', uom: 'PCS', tracking: 'NONE' }, lot: null, scans: 2, scanned: '36.0000' })

describe('what to count', () => {
  const toCount: ToCount = {
    asOf: '2026-11-12T09:00:00.000Z',
    bins: [
      { count, location: place, kind: 'COUNT', lines: 3, since: '2026-11-12T07:00:00.000Z', yours: false },
      { count, location: { ...place, id: 'loc-2', code: 'A1-STORE-02', labelCode: null }, kind: 'RECOUNT', lines: 1, since: '2026-11-12T08:00:00.000Z', yours: true },
    ],
  }
  it('offers what the person may count, never a recount of their own count', () => {
    expect(openBins(toCount).map((row) => row.location.code)).toEqual(['A1-STORE-01'])
    expect(openBins(null)).toEqual([])
  })
  it('finds a row by its label or code, any case, offline', () => {
    expect(binOfCode(toCount, 'bin-a1-store-01')?.location.id).toBe('loc-1')
    expect(binOfCode(toCount, 'A1-STORE-01')?.location.id).toBe('loc-1')
    // A recount the person may not do is not a bin to open.
    expect(binOfCode(toCount, 'A1-STORE-02')).toBeNull()
  })
})

describe('scan every unit, blind', () => {
  const read = (code: string) => readScan(code, null)
  it('a hide tag counts by its scan; a lot label asks its quantity; anything else asks the office', () => {
    const scanned = bin([HIDE_LINE, LOT_LINE, PCS_LINE])
    expect(unitOfScan(scanned, read('HD-AAA-1'))).toEqual({ kind: 'tag', code: 'HD-AAA-1', line: HIDE_LINE })
    expect(unitOfScan(scanned, read('lot-31'))).toEqual({ kind: 'quantity', code: 'lot-31', line: LOT_LINE })
    expect(unitOfScan(scanned, read('LOT-99'))).toEqual({ kind: 'ask', code: 'LOT-99' })
  })
  it('the big numeral counts units in their pass and what this tablet keeps; a counted line counts no more', () => {
    const scanned = bin([HIDE_LINE, PCS_LINE, line(40, { pass: null, scans: 5 })])
    expect(unitsScanned(scanned)).toBe(3)
    expect(unitsScanned(scanned, [{ clientEventId: 'c', code: 'X', lineId: null, quantity: null }])).toBe(4)
    expect(lineTally(PCS_LINE, [{ clientEventId: 'c', code: null, lineId: 'ln-30', quantity: '4' }])).toEqual({ scans: 3, scanned: 40, kept: 1 })
    expect(unitsScanned(null)).toBe(0)
  })
  it('only a line without a tag of its own is typed on the pad; whole pieces for a count unit', () => {
    expect(padLines(bin([HIDE_LINE, LOT_LINE, PCS_LINE, line(40, { hide: null, pass: null })])).map((entry) => entry.seq)).toEqual([20, 30])
    expect(padBounds('PCS')).toEqual({ min: 1, decimals: 0 })
    expect(padBounds('M')).toEqual({ min: 0.01, decimals: 2 })
    expect(quantityText(20.5, 2)).toBe('20.50')
  })
  it('a unit\'s answer replaces its line, a unit not expected adds one; a bin all counted; the pass', () => {
    const before = bin([HIDE_LINE, LOT_LINE])
    expect(withLine(before, { ...LOT_LINE, scans: 1, scanned: '20.0000' }).lines[1]!.scans).toBe(1)
    expect(withLine(before, line(50, { origin: 'ADDED' })).lines).toHaveLength(3)
    expect(binCounted(bin([{ ...HIDE_LINE, pass: null }]))).toBe(true)
    expect(binCounted(bin([]))).toBe(false)
    expect(passOf(bin([HIDE_LINE, { ...LOT_LINE, pass: 'RECOUNT' }]))).toBe('RECOUNT')
  })
})

describe('differences after Bin done', () => {
  const diff = (seq: number, kind: Difference['kind']): Difference => ({ lineId: `ln-${seq}`, seq, item: { id: 'i', code: 'PEL', name: 'Leather', uom: 'FT2' }, lot: null, hide: null, pass: 'COUNT', expected: '1', scanned: '0', scans: 0, difference: '-1', kind })
  it('missing first, then extra, short, over; what matches apart', () => {
    const rows = differenceRows([diff(10, 'MATCH'), diff(20, 'OVER'), diff(30, 'EXTRA'), diff(40, 'MISSING'), diff(5, 'MISSING')])
    expect(rows.differ.map((row) => `${row.kind}:${row.seq}`)).toEqual(['MISSING:5', 'MISSING:40', 'EXTRA:30', 'OVER:20'])
    expect(rows.match.map((row) => row.seq)).toEqual([10])
  })
})

describe('the API\'s refusals in the screen\'s words', () => {
  it('reads refusal/<CODE> in a 409 and a 400, a label of no place, else the floor\'s problem', () => {
    expect(countProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/ALREADY_COUNTED', message: 'counted' }]))).toMatchObject({ kind: 'refused', code: 'ALREADY_COUNTED' })
    expect(countProblemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'refusal/QUANTITY', message: 'how much' }]))).toMatchObject({ kind: 'refused', code: 'QUANTITY' })
    expect(countProblemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'placeCode', message: 'No place of this site' }]))).toMatchObject({ kind: 'refused', code: 'NOT_A_PLACE' })
    expect(countProblemOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ kind: 'offline' })
    expect(['NOT_COUNTING', 'OWN_RECOUNT', 'NO_COUNT_HERE'].every(knownRefusal)).toBe(true)
    expect(knownRefusal('CONFLICT')).toBe(false)
  })
})

describe('SCR-178\'s design cases', () => {
  it('cover every state the brief names, each id once', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['what', 'what-empty', 'what-loading', 'what-error', 'what-offline', 'choose', 'bin', 'bin-already', 'bin-pad-line', 'bin-offline', 'differences', 'differences-none', 'differences-moved', 'finished', 'finished-recounts', 'finished-kept', 'refused-own-recount', 'error', 'notice-held', 'no-permission']) expect(ids).toContain(id)
  })
})
