import { describe, expect, it } from 'vitest'
import { moveRefusal, openedFrom, openRefusal, statusAfter, type OpenFacts } from './rules'

/** The rework loop's rules (B-W2a-13; MES-126). */

const base: OpenFacts = {
  workOrder: { number: 'WO-7', status: 'IN_PROGRESS' },
  quantity: 2,
  reasonCode: 'RESTITCH',
  activeReasons: ['RESTITCH', 'ALIGNMENT'],
  foundAt: { seq: 30 },
  reworkAt: { seq: 20 },
  source: { kind: 'REPORT', voided: false, reworkQuantity: 3, opened: 1 },
  bundle: { code: 'B-9', status: 'ACTIVE', live: 12, sameCell: true },
  nextReported: null,
}

describe('opening a rework', () => {
  it('takes rework a scan counted, up to what is not sent back yet', () => {
    expect(openRefusal(base)).toBeNull()
    expect(openRefusal({ ...base, quantity: 3 })).toEqual({ code: 'MORE_THAN_COUNTED', message: 'That scan counted 3 garments as rework; 2 not yet sent back, 3 asked.' })
    expect(openRefusal({ ...base, source: { ...base.source!, opened: 3 } })?.message).toBe('Every garment that scan counted as rework (3) is sent back already.')
    expect(openRefusal({ ...base, source: { ...base.source!, voided: true } })?.code).toBe('NOT_A_REWORK_SCAN')
    expect(openRefusal({ ...base, source: { ...base.source!, kind: 'UNDO' } })?.code).toBe('NOT_A_REWORK_SCAN')
  })

  it('needs an open work order (a held one takes new rework), an active reason, and an operation at or before the fault', () => {
    expect(openRefusal({ ...base, workOrder: { number: 'WO-7', status: 'ON_HOLD' } })).toBeNull()
    expect(openRefusal({ ...base, workOrder: { number: 'WO-7', status: 'COMPLETED' } })?.code).toBe('WORK_ORDER_NOT_OPEN')
    expect(openRefusal({ ...base, reasonCode: 'CLEANING' })?.message).toBe('CLEANING is not an active rework reason: pick one of RESTITCH, ALIGNMENT.')
    expect(openRefusal({ ...base, reworkAt: { seq: 40 } })?.code).toBe('REWORK_AT_LATER')
  })

  it('travels in an ACTIVE bundle of the cell that carries the garments', () => {
    expect(openRefusal({ ...base, bundle: { ...base.bundle!, status: 'VOID' } })?.code).toBe('BUNDLE_NOT_ACTIVE')
    expect(openRefusal({ ...base, bundle: { ...base.bundle!, sameCell: false } })?.code).toBe('NOT_OF_CELL')
    expect(openRefusal({ ...base, bundle: { ...base.bundle!, live: 1 } })?.message).toBe('Bundle B-9 carries 1 garment; 2 asked.')
    expect(openRefusal({ ...base, source: null, nextReported: { seq: 40 } })?.code).toBe('NEXT_REPORTED')
  })

  it('counts what a scan sent back already: reworks of it that are not cancelled', () => {
    const rows = [
      { sourceScanId: 's1', status: 'DONE' as const, quantity: 1 },
      { sourceScanId: 's1', status: 'CANCELLED' as const, quantity: 4 },
      { sourceScanId: 's2', status: 'OPEN' as const, quantity: 2 },
      { sourceScanId: 's1', status: 'IN_PROGRESS' as const, quantity: 2 },
    ]
    expect(openedFrom(rows, 's1')).toBe(3)
  })
})

describe('moving a rework', () => {
  const rework = { status: 'OPEN' as const, quantity: 3 }
  const order = { number: 'WO-7', status: 'IN_PROGRESS' as const }

  it('starts, finishes with good + scrapped = its garments, or is cancelled', () => {
    expect(statusAfter('start')).toBe('IN_PROGRESS')
    expect(moveRefusal({ workOrder: order, rework, move: 'start' })).toBeNull()
    expect(moveRefusal({ workOrder: order, rework, move: 'done', good: 2, scrap: 1 })).toBeNull()
    expect(moveRefusal({ workOrder: order, rework, move: 'done', good: 2, scrap: 0 })).toEqual({ code: 'COUNTS_DO_NOT_ADD_UP', message: 'This rework sent back 3 garments: good and scrapped add up to them (2 + 0 given).' })
    expect(moveRefusal({ workOrder: order, rework: { ...rework, status: 'DONE' }, move: 'cancel' })?.code).toBe('WRONG_STATE')
    expect(moveRefusal({ workOrder: order, rework: { ...rework, status: 'IN_PROGRESS' }, move: 'start' })?.code).toBe('WRONG_STATE')
  })

  it('moves on only while the work order is RELEASED or IN_PROGRESS: a hold in words; a cancel any time', () => {
    expect(moveRefusal({ workOrder: { number: 'WO-7', status: 'ON_HOLD', holdReason: 'NCR 12' }, rework, move: 'start' })).toEqual({
      code: 'WORK_ORDER_ON_HOLD',
      message: 'Work order WO-7 is on hold (NCR 12): its rework moves on once the hold is lifted.',
    })
    expect(moveRefusal({ workOrder: { number: 'WO-7', status: 'ON_HOLD' }, rework, move: 'cancel' })).toBeNull()
    expect(moveRefusal({ workOrder: { number: 'WO-7', status: 'CLOSED' }, rework, move: 'done', good: 3, scrap: 0 })?.code).toBe('WORK_ORDER_NOT_OPEN')
  })
})
