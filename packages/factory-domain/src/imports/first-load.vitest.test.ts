import { describe, expect, it } from 'vitest'
import { doneProblems, judge, stepStateOf, type Reconciliation } from './first-load'

const clean: Reconciliation = { rows: 120, loaded: 120, refused: 0, skipped: 0 }

describe('the guided first load (PLT-185)', () => {
  it('matches only when every row of the sheet is loaded, quantities agree and the value is within rounding', () => {
    expect(judge(clean)).toEqual({ matches: true, differences: [] })
    expect(judge({ ...clean, loaded: 114, refused: 6 }).differences.map((issue) => issue.path)).toEqual(['difference/refused'])
    expect(judge({ ...clean, loaded: 118, skipped: 1 }).differences.map((issue) => issue.path)).toEqual(['difference/skipped', 'difference/missing'])
    expect(judge({ ...clean, quantities: [{ unit: 'M2', sheet: '12.5000', loaded: '12.50' }] }).matches).toBe(true)
    expect(judge({ ...clean, quantities: [{ unit: 'M2', sheet: '12.5', loaded: '10' }] }).differences[0]).toEqual({ path: 'difference/quantity/M2', message: 'M2: 12.5 in the sheet, 10 loaded.' })
    const value = { sheet: 8421000, loaded: 8421002, atStandard: 0, rowsAtStandard: 0, tolerance: 3, currency: 'EUR' }
    expect(judge({ ...clean, value }).matches).toBe(true)
    expect(judge({ ...clean, value: { ...value, loaded: 8420000 } }).differences[0]!.message).toBe('Stock value: 84210.00 EUR in the sheet, 84200.00 EUR loaded.')
    expect(judge({ rows: 0, loaded: 0, refused: 0, skipped: 0 }).matches).toBe(false)
  })

  it('goes in order: a step waits for the one before, open orders have no importer', () => {
    const facts = { step: 'materials' as const, done: null, running: false, applied: clean }
    expect(stepStateOf(facts, false)).toBe('waiting')
    expect(stepStateOf(facts, true)).toBe('ready')
    expect(stepStateOf({ ...facts, applied: { ...clean, refused: 1, loaded: 119 } }, true)).toBe('mismatch')
    expect(stepStateOf({ ...facts, applied: null }, true)).toBe('todo')
    expect(stepStateOf({ ...facts, running: true }, true)).toBe('running')
    expect(stepStateOf({ ...facts, done: { at: '2026-10-30T08:00:00.000Z', nothing: false } }, false)).toBe('done')
    expect(stepStateOf({ step: 'openOrders', done: null, running: false, applied: null }, true)).toBe('held')
  })

  it('refuses Done with the reasons, and allows "nothing to load" only without loaded records', () => {
    const earlier = [{ step: 'customers' as const, done: true }, { step: 'suppliers' as const, done: false }]
    expect(doneProblems({ step: 'materials', earlier, applied: clean, nothing: false, alreadyDone: false }).map((issue) => issue.path)).toEqual(['step/waiting/suppliers'])
    expect(doneProblems({ step: 'materials', earlier: [], applied: null, nothing: false, alreadyDone: false }).map((issue) => issue.path)).toEqual(['step/noImport'])
    expect(doneProblems({ step: 'materials', earlier: [], applied: { ...clean, refused: 2, loaded: 118 }, nothing: false, alreadyDone: false }).map((issue) => issue.path)).toEqual(['difference/refused'])
    expect(doneProblems({ step: 'materials', earlier: [], applied: clean, nothing: false, alreadyDone: false })).toEqual([])
    expect(doneProblems({ step: 'openOrders', earlier: [], applied: null, nothing: false, alreadyDone: false }).map((issue) => issue.path)).toEqual(['step/noImporter'])
    expect(doneProblems({ step: 'openOrders', earlier: [], applied: null, nothing: true, alreadyDone: false })).toEqual([])
    expect(doneProblems({ step: 'materials', earlier: [], applied: clean, nothing: true, alreadyDone: false }).map((issue) => issue.path)).toEqual(['body/nothing'])
    expect(doneProblems({ step: 'materials', earlier: [], applied: clean, nothing: false, alreadyDone: true }).map((issue) => issue.path)).toEqual(['step/done'])
  })
})
