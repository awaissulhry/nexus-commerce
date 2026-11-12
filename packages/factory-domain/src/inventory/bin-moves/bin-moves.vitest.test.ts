import { describe, expect, it } from 'vitest'
import { suggestPlace } from '../putaway/rules'
import { fromRefusal, qualityOf, quantityToMove, toRefusal, UNDO_WINDOW_MS, undoRefusal, type InHand } from './rules'

/** Moves on the floor (B-W2b-292; SCM-202, SCM-218), the pure rules. Made-up codes only. */

const lot: InHand = { kind: 'LOT', label: 'Lot L-1', lotStatus: 'RELEASED', onHold: false, whole: false }
const hide: InHand = { kind: 'HIDE', label: 'Hide H-1', lotStatus: 'RELEASED', onHold: false, whole: true }
const place = (id: string, kind = 'BIN', status = 'ACTIVE') => ({ id, code: id.toUpperCase(), kind, status })

describe('in your hands', () => {
  it('shows a hold first, then the lot’s status', () => {
    expect(qualityOf({ lotStatus: 'RELEASED', onHold: true })).toBe('ON_HOLD')
    expect(qualityOf({ lotStatus: 'QUARANTINE', onHold: false })).toBe('QUARANTINE')
    expect(qualityOf({ lotStatus: null, onHold: false })).toBe('RELEASED')
  })

  it('moves from the only place, or the one named when it lies in several', () => {
    expect(fromRefusal(lot, [], null)).toMatchObject({ code: 'NOTHING_HERE' })
    expect(fromRefusal(lot, [place('a1')], null)).toBeNull()
    expect(fromRefusal(lot, [place('a1'), place('a2')], null)).toEqual({ code: 'NAME_THE_PLACE', message: 'Lot L-1 lies in 2 places (A1, A2): say which one it is moved from.' })
    expect(fromRefusal(lot, [place('a1'), place('a2')], 'a2')).toBeNull()
    expect(fromRefusal(lot, [place('a1')], 'a3')).toMatchObject({ code: 'NOTHING_HERE' })
  })
})

describe('the place', () => {
  it('refuses the place it is in and an archived place', () => {
    expect(toRefusal(lot, place('a1'), place('a1'))).toEqual({ code: 'SAME_PLACE', message: 'Lot L-1 is in A1 already.' })
    expect(toRefusal(lot, place('a1'), place('a2', 'BIN', 'ARCHIVED'))).toMatchObject({ code: 'ARCHIVED' })
    expect(toRefusal(lot, place('a1'), place('a2'))).toBeNull()
  })

  it('lets stock not released go only into a quarantine place', () => {
    const held = { ...lot, onHold: true }
    expect(toRefusal(held, place('a1'), place('a2'))).toEqual({ code: 'QUARANTINE_ONLY', message: 'Lot L-1 is on a quality hold: it moves only into a quarantine place until quality releases it.' })
    expect(toRefusal(held, place('a1'), place('q1', 'QUARANTINE'))).toBeNull()
    expect(toRefusal({ ...lot, lotStatus: 'QUARANTINE' }, place('dock', 'RECEIVING'), place('a2'))?.message).toContain('is in quarantine')
  })
})

describe('how much', () => {
  it('moves a hide whole, a lot in part up to what lies there', () => {
    expect(quantityToMove(hide, '53.2', undefined)).toMatchObject({ quantity: expect.anything() })
    expect(quantityToMove(hide, '53.2', '10')).toMatchObject({ refusal: { code: 'WHOLE_ONLY' } })
    expect(String((quantityToMove(lot, '30', '12.5') as { quantity: unknown }).quantity)).toBe('12.5')
    expect(String((quantityToMove(lot, '30', null) as { quantity: unknown }).quantity)).toBe('30')
    expect(quantityToMove(lot, '30', '31')).toEqual({ refusal: { code: 'TOO_MUCH', message: 'Only 30 of Lot L-1 lies there.' } })
  })
})

describe('undo', () => {
  const at = new Date('2026-11-12T09:00:00Z')
  const move = { own: true, postedAt: at, undone: false, transfer: true }
  it('is the poster’s own, within 2 minutes, once', () => {
    expect(undoRefusal(move, new Date(at.getTime() + UNDO_WINDOW_MS))).toBeNull()
    expect(undoRefusal(move, new Date(at.getTime() + UNDO_WINDOW_MS + 1))).toMatchObject({ code: 'TOO_LATE' })
    expect(undoRefusal({ ...move, own: false }, at)).toMatchObject({ code: 'NOT_YOURS' })
    expect(undoRefusal({ ...move, undone: true }, at)).toMatchObject({ code: 'UNDONE' })
    expect(undoRefusal({ ...move, transfer: false }, at)).toMatchObject({ code: 'NOT_A_MOVE' })
  })
})

describe('the put-away suggestion (SCM-202)', () => {
  const base = { fromId: 'dock', released: true, qualityPlace: { id: 'q1', code: 'Q1' }, defaultPlace: null, sameLot: [] }
  it('takes goods not released to the quality place', () => {
    expect(suggestPlace({ ...base, released: false })).toEqual({ location: { id: 'q1', code: 'Q1' }, why: 'QUALITY' })
    expect(suggestPlace({ ...base, released: false, qualityPlace: null })).toBeNull()
  })

  it('takes released goods to the default for its kind, else where the same lot lies', () => {
    expect(suggestPlace({ ...base, defaultPlace: { id: 'b1', code: 'B1' } })).toEqual({ location: { id: 'b1', code: 'B1' }, why: 'DEFAULT' })
    const sameLot = [
      { id: 'dock', code: 'DOCK', kind: 'RECEIVING', onHand: '40' },
      { id: 'b2', code: 'B2', kind: 'BIN', onHand: '5' },
      { id: 'b3', code: 'B3', kind: 'BIN', onHand: '9' },
      { id: 'q1', code: 'Q1', kind: 'QUARANTINE', onHand: '50' },
    ]
    expect(suggestPlace({ ...base, sameLot })).toEqual({ location: { id: 'b3', code: 'B3' }, why: 'SAME_LOT' })
    expect(suggestPlace({ ...base, defaultPlace: { id: 'dock', code: 'DOCK' }, sameLot: [] })).toBeNull()
  })
})
