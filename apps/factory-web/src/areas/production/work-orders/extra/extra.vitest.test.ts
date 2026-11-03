import { describe, expect, it } from 'vitest'
import { minutesOf } from '../every-shift/model'
import { extraHeld, type ExtraDialogModel } from './use-extra'

const dialog = (over: Partial<ExtraDialogModel['draft']> = {}, more: Partial<ExtraDialogModel> = {}): ExtraDialogModel => ({
  choices: {
    operations: [{ id: 'lib', code: 'FIX', name: 'Fix', workCentreKind: 'SEWING', standardMinutes: '1.500', pays: 'PIECE_RATE' }],
    reasons: [
      { code: 'QUALITY_FIX', label: { it: 'Difetto', en: 'Defect' }, needsNote: false },
      { code: 'OTHER', label: { it: 'Altro', en: 'Other' }, needsNote: true },
    ],
  },
  draft: { operationId: null, reasonCode: null, note: '', ...over },
  busy: false,
  problem: null,
  ...more,
})

describe('Add an unplanned operation in the office (B-W2b-82)', () => {
  it('Add waits for the operation, the reason and the words of Other, in words', () => {
    expect(extraHeld(dialog())).toBe('extra.held.operation')
    expect(extraHeld(dialog({ operationId: 'lib' }))).toBe('extra.held.reason')
    expect(extraHeld(dialog({ operationId: 'lib', reasonCode: 'QUALITY_FIX' }))).toBeNull()
    expect(extraHeld(dialog({ operationId: 'lib', reasonCode: 'OTHER' }))).toBe('extra.held.note')
    expect(extraHeld(dialog({ operationId: 'lib', reasonCode: 'OTHER', note: 'Extra tack' }))).toBeNull()
    expect(extraHeld(dialog({ operationId: 'lib', reasonCode: 'QUALITY_FIX' }, { busy: true }))).toBe('held.busy')
  })
})

describe('the minutes card', () => {
  it('earns what the unplanned operation reported, and plans none of it', () => {
    const operation = (seq: number, routingSeq: number | null, scanRequired: boolean, standardMinutes: string) => ({ id: `op-${seq}`, seq, routingSeq, code: `OP${seq}`, name: `Op ${seq}`, standardMinutes, scanRequired, workCentreKind: 'SEWING', workCentreId: null, workCentreCode: null })
    const spec = { frozen: true, frozenAt: null, operations: [operation(10, 10, true, '2.000'), operation(50, null, false, '1.500')], materials: [], standardMinutes: { perGarment: '2.000', allPieces: '20.000' } }
    const wip = { operations: [{ seq: 10, good: 10 }, { seq: 50, good: 4 }] }
    const minutes = minutesOf({ pieces: 10, spec } as unknown as Parameters<typeof minutesOf>[0], wip as unknown as Parameters<typeof minutesOf>[1])
    expect(minutes.rows.map((row) => [row.seq, row.planned, row.earned])).toEqual([
      [10, 20, 20],
      [50, 0, 6],
    ])
    expect(minutes).toMatchObject({ planned: 20, earned: 26, unscanned: 0 })
  })
})
