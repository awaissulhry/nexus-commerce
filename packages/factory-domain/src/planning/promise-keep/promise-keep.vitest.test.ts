import { describe, expect, it } from 'vitest'
import type { StoredPromise } from '../promise/rules'
import { lineHistoryOf, namedReasonCode, sizeHistoryOf, sizeTimeline, slippedBetween, typedChangeRowsOf } from './history'
import { customerMessageOf, proposalStateOf, repromiseProblems } from './repromise'
import { finishWithMaterial, monthOf, riskOf, slackDays, worstRisk } from './risk'

const at = (iso: string) => new Date(iso)
const row = (id: string, size: string | null, promisedDate: string, kind: 'FIRST' | 'RE_PROMISE', when: string): StoredPromise => ({ id, size, promisedDate, kind, promisedAt: at(when) })

// A line promised 4 Dec for every size, size 52 moved to 11 Dec, then every size to 6 Dec, then 52 back to 9 Dec.
const ROWS: StoredPromise[] = [
  row('a', null, '2026-12-04', 'FIRST', '2026-11-01T09:00:00Z'),
  row('b', '52', '2026-12-11', 'RE_PROMISE', '2026-11-05T09:00:00Z'),
  row('c', null, '2026-12-06', 'RE_PROMISE', '2026-11-10T09:00:00Z'),
  row('d', '52', '2026-12-09', 'RE_PROMISE', '2026-11-12T09:00:00Z'),
]

describe('one promise history per line (PLN-173)', () => {
  it("walks a size's promise in the order the rows were made: its own rows win once it has one", () => {
    expect(sizeTimeline('50', ROWS).map((step) => [step.date, step.shiftDays])).toEqual([
      ['2026-12-04', null],
      ['2026-12-06', 2],
    ])
    // 52 has its own rows from b on: the every-size row c no longer reaches it.
    expect(sizeTimeline('52', ROWS).map((step) => [step.date, step.shiftDays, step.ownSize])).toEqual([
      ['2026-12-04', null, false],
      ['2026-12-11', 7, true],
      ['2026-12-09', -2, true],
    ])
  })

  it('keeps the first promise forever and counts changes and slips (a move later)', () => {
    const h52 = sizeHistoryOf('52', ROWS, null, null)
    expect(h52).toMatchObject({ first: { date: '2026-12-04', source: 'RECORD' }, current: { date: '2026-12-09', ownSize: true }, changes: 2, slips: 1, driftDays: 5 })
    const line = lineHistoryOf(['50', '52', '54'], ROWS, null, null)
    // b and c moved a size later, d earlier: 3 changes (rows), 2 slips.
    expect(line).toMatchObject({ first: '2026-12-04', current: '2026-12-09', changes: 3, slips: 2 })
    // Without rows, the first promise is the first date typed (W1's originalPromiseDate).
    expect(sizeHistoryOf('50', [], '2026-12-20', '2026-12-04')).toMatchObject({ first: { date: '2026-12-04', source: 'TYPED' }, current: { date: '2026-12-20', source: 'TYPED' }, changes: 0 })
    expect(slippedBetween(sizeTimeline('52', ROWS), at('2026-11-01T00:00:00Z'), at('2026-11-06T00:00:00Z'))).toBe(true)
    expect(slippedBetween(sizeTimeline('52', ROWS), at('2026-11-11T00:00:00Z'), at('2026-12-01T00:00:00Z'))).toBe(false)
  })

  it("writes the rows of W1's typed change: the first promise first, the new date for every size and each size apart", () => {
    // Never promised: the new date is the line's first promise.
    expect(typedChangeRowsOf({ sizes: ['50', '52'], rows: [], first: null, date: '2026-12-10', reason: 'Asked by the customer', orderDate: '2026-11-01' })).toEqual([{ size: null, promisedDate: '2026-12-10', kind: 'FIRST', reasonCode: null, reason: null, backfill: false }])
    // Promised (typed) before: that date stays the first promise (a backfill), then the move with its words and code.
    expect(typedChangeRowsOf({ sizes: ['50', '52'], rows: [], first: '2026-12-04', date: '2026-12-10', reason: 'MATERIAL_LATE: tannery batch late', orderDate: '2026-11-01' })).toEqual([
      { size: null, promisedDate: '2026-12-04', kind: 'FIRST', reasonCode: null, reason: null, backfill: true },
      { size: null, promisedDate: '2026-12-10', kind: 'RE_PROMISE', reasonCode: 'MATERIAL_LATE', reason: 'MATERIAL_LATE: tannery batch late', backfill: false },
    ])
    // With rows: every size gets the new date, and size 52 (promised apart) too.
    expect(typedChangeRowsOf({ sizes: ['50', '52', '54'], rows: ROWS, first: null, date: '2026-12-15', reason: 'Production capacity', orderDate: '2026-11-01' }).map((entry) => [entry.size, entry.kind, entry.reasonCode])).toEqual([
      [null, 'RE_PROMISE', 'CAPACITY'],
      ['52', 'RE_PROMISE', 'CAPACITY'],
    ])
    // Every size already has the date: nothing; a date before the order's: nothing (the database refuses it).
    expect(typedChangeRowsOf({ sizes: ['50'], rows: [row('a', null, '2026-12-04', 'FIRST', '2026-11-01T09:00:00Z')], first: null, date: '2026-12-04', reason: 'x', orderDate: '2026-11-01' })).toEqual([])
    expect(typedChangeRowsOf({ sizes: ['50'], rows: [], first: '2026-12-04', date: '2026-10-30', reason: 'x', orderDate: '2026-11-01' })).toEqual([])
    // Only sizes promised apart (B-W2b-301's per-size FIRST rows), one size without: the every-size row reaches it.
    const apart = [row('p', '50', '2026-12-04', 'FIRST', '2026-11-01T09:00:00Z'), row('q', '52', '2026-12-11', 'FIRST', '2026-11-01T09:00:00Z')]
    expect(typedChangeRowsOf({ sizes: ['50', '52', '54'], rows: apart, first: null, date: '2026-12-11', reason: 'x', orderDate: '2026-11-01' }).map((entry) => entry.size)).toEqual([null, '50'])
  })

  it('reads a reason code only when the text names one', () => {
    expect(namedReasonCode('TRANSPORT')).toBe('TRANSPORT')
    expect(namedReasonCode('Consegna dei materiali in ritardo')).toBe('MATERIAL_LATE')
    expect(namedReasonCode('SIZES_FINISH_APART: 54 later')).toBe('SIZES_FINISH_APART')
    expect(namedReasonCode('the customer phoned')).toBeNull()
  })
})

describe('orders at risk (PLN-174)', () => {
  it('compares the planned finish with the promise', () => {
    const today = '2026-11-12'
    expect(riskOf({ open: 2, promise: '2026-12-04', finish: '2026-12-01', today })).toBe('ON_TIME')
    expect(riskOf({ open: 2, promise: '2026-12-04', finish: '2026-12-11', today })).toBe('AT_RISK')
    expect(riskOf({ open: 2, promise: '2026-12-04', finish: null, today })).toBe('AT_RISK')
    expect(riskOf({ open: 2, promise: '2026-11-10', finish: '2026-11-09', today })).toBe('LATE')
    expect(riskOf({ open: 2, promise: null, finish: '2026-11-20', today })).toBe('NOT_PROMISED')
    expect(riskOf({ open: 0, promise: '2026-11-10', finish: null, today })).toBeNull()
    expect(worstRisk(['ON_TIME', null, 'AT_RISK', 'NOT_PROMISED'])).toBe('AT_RISK')
    expect(slackDays('2026-12-04', '2026-12-01')).toBe(3)
    expect(slackDays('2026-12-04', '2026-12-11')).toBe(-7)
  })

  it('moves a finish by the days its material comes after the planned start (a late supplier date replans what it feeds)', () => {
    expect(finishWithMaterial({ plannedStart: '2026-11-14', plannedFinish: '2026-11-20', materialStart: '2026-11-21', notCovered: false })).toEqual({ finish: '2026-11-27', delayDays: 7 })
    expect(finishWithMaterial({ plannedStart: '2026-11-14', plannedFinish: '2026-11-20', materialStart: '2026-11-10', notCovered: false })).toEqual({ finish: '2026-11-20', delayDays: 0 })
    expect(finishWithMaterial({ plannedStart: '2026-11-14', plannedFinish: '2026-11-20', materialStart: null, notCovered: true })).toEqual({ finish: null, delayDays: 0 })
    expect(monthOf('2026-12-04')).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})

describe('the re-promise workflow (PLN-175)', () => {
  it('asks a reason and a new date for a size already promised', () => {
    expect(repromiseProblems({ sizes: [{ size: '52', from: '2026-12-04', to: '2026-12-11' }], reasonCode: 'MATERIAL_LATE' })).toEqual([])
    expect(repromiseProblems({ sizes: [{ size: '52', from: '2026-12-04', to: '2026-12-04' }, { size: '54', from: null, to: '2026-12-11' }], reasonCode: undefined }).map((problem) => problem.path)).toEqual(['body/reasonCode', 'body/sizes/0/date', 'body/sizes/1/size'])
    expect(repromiseProblems({ sizes: [{ size: '52', from: '2026-12-04', to: '2026-12-11' }], reasonCode: 'WHATEVER' })[0]!.path).toBe('body/reasonCode')
  })

  it('a proposal waits while its task is open and nobody decided', () => {
    expect(proposalStateOf(null, 'OPEN')).toBe('WAITING')
    expect(proposalStateOf('ACCEPTED', 'DONE')).toBe('ACCEPTED')
    expect(proposalStateOf(null, 'DONE')).toBe('CLOSED')
  })

  it("writes the customer's message in their language, the reason in its curated words, sorry only when later", () => {
    const base = { orderNumber: 'SO-0042', customerRef: 'PO-77', lineSeq: 10, style: { code: 'JKT-1', name: 'Touring jacket' }, colourway: { code: 'BLK', name: 'Black' }, reasonCode: 'MATERIAL_LATE' }
    const it = customerMessageOf({ ...base, language: 'it', sizes: [{ size: '52', from: '2026-12-04', to: '2026-12-11' }] })
    expect(it.subject).toBe('Ordine SO-0042: nuova data di consegna')
    expect(it.body).toContain('- taglia 52: 4 dicembre 2026 → 11 dicembre 2026')
    expect(it.body).toContain('Motivo: Consegna dei materiali in ritardo.')
    expect(it.body).toContain('Ci scusiamo per il disagio.')
    expect(it.body).toContain('(vostro riferimento PO-77)')
    const en = customerMessageOf({ ...base, language: 'en', reasonCode: 'EARLIER', sizes: [{ size: '52', from: '2026-12-11', to: '2026-12-04' }] })
    expect(en.body).toContain('- size 52: 11 December 2026 → 4 December 2026')
    expect(en.body).toContain('Reason: Ready earlier than planned.')
    expect(en.body).not.toContain('sorry')
  })
})
