import { describe, expect, it } from 'vitest'
import { fromByLineOf, isFirstPromise, PROMISE_MOVE_KINDS, promiseMoveKindOf } from './promise-moves'

/**
 * B-PT-011 (order production tab R11): ONE rule for a first promise and a move — the production read's "moved N×" and the order
 * read's promise history use it both — and each line's own day before a lines' move. Made-up ids and days.
 */

const LINE_A = '11111111-1111-4111-8111-111111111111'
const LINE_B = '22222222-2222-4222-8222-222222222222'

describe('isFirstPromise / promiseMoveKindOf: the row that set the first promise is not a move', () => {
  it('the order had none (originalPromiseDate null, the order’s change and the lines’ alike): SET', () => {
    expect(isFirstPromise({ promiseDate: null, originalPromiseDate: null })).toBe(true)
    expect(isFirstPromise({ lines: { [LINE_A]: null }, originalPromiseDate: null })).toBe(true)
    expect(promiseMoveKindOf({ promiseDate: null, originalPromiseDate: null })).toBe('SET')
  })

  it('the order had a first promise: MOVED; a row that does not say counts as a move (as before)', () => {
    expect(isFirstPromise({ promiseDate: '2026-12-01', originalPromiseDate: '2026-12-01' })).toBe(false)
    for (const before of [{ promiseDate: '2026-12-01' }, null, 'text', 3, []]) {
      expect(isFirstPromise(before)).toBe(false)
      expect(promiseMoveKindOf(before)).toBe('MOVED')
    }
    expect(PROMISE_MOVE_KINDS).toEqual(['SET', 'MOVED'])
  })
})

describe('fromByLineOf: a lines’ move names each line’s own day before it', () => {
  it('two lines on different days (a mixed move): each with its day; a line with none: null', () => {
    expect(fromByLineOf({ lines: { [LINE_A]: '2026-12-05', [LINE_B]: null }, originalPromiseDate: '2026-12-01' })).toEqual([
      { lineId: LINE_A, from: '2026-12-05' },
      { lineId: LINE_B, from: null },
    ])
  })

  it('a move of the whole order names no line: null; a key that is not a line id is left out, a day that is not one reads null', () => {
    expect(fromByLineOf({ promiseDate: '2026-12-01', originalPromiseDate: '2026-12-01' })).toBeNull()
    expect(fromByLineOf(null)).toBeNull()
    expect(fromByLineOf({ lines: ['x'] })).toBeNull()
    expect(fromByLineOf({ lines: { 'not-a-line': '2026-12-05', [LINE_A]: '2026-02-30' } })).toEqual([{ lineId: LINE_A, from: null }])
  })
})
