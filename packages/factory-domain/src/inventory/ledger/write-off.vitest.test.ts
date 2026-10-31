import { describe, expect, it } from 'vitest'
import { writeOffGroupOf, writeOffLineProblems, writeOffNote, writeOffOf, writeOffReasonProblem } from './write-off'

describe('write-off', () => {
  it('writes the reason code first in the note and reads it back from its own moves only', () => {
    expect(writeOffNote('DAMAGED', ' water stain on the back ')).toBe('DAMAGED: water stain on the back')
    expect(writeOffNote('LOST', null)).toBe('LOST')
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k1:1', note: 'DAMAGED: water stain' })).toEqual({ reasonCode: 'DAMAGED', note: 'water stain' })
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k1:2', note: 'LOST' })).toEqual({ reasonCode: 'LOST', note: null })
    // A W1 scrap (its own key) or another reason is no write-off.
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.scrap:k1:1', note: 'DAMAGED: x' })).toBeNull()
    expect(writeOffOf({ reason: 'ADJUSTMENT', idempotencyKey: 'inventory.writeOff:k1:1', note: 'DAMAGED: x' })).toBeNull()
  })

  it('B-W2b-15: reads the code from the move\'s reasonCode first (the note keeps it in front for the screens)', () => {
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k2:1', note: 'DAMAGED: water stain', reasonCode: 'DAMAGED' })).toEqual({ reasonCode: 'DAMAGED', note: 'water stain' })
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k2:1', note: 'EXPIRED', reasonCode: 'EXPIRED' })).toEqual({ reasonCode: 'EXPIRED', note: null })
    // A note in the person's words only (no code in front) is kept whole.
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k2:1', note: 'Wet: left by the door', reasonCode: 'DAMAGED' })).toEqual({ reasonCode: 'DAMAGED', note: 'Wet: left by the door' })
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k2:1', note: null, reasonCode: 'LOST' })).toEqual({ reasonCode: 'LOST', note: null })
    // A write-off of before W2b has no column value: the note's first word.
    expect(writeOffOf({ reason: 'SCRAP', idempotencyKey: 'inventory.writeOff:k2:1', note: 'OBSOLETE: old season', reasonCode: null })).toEqual({ reasonCode: 'OBSOLETE', note: 'old season' })
  })

  it('groups the moves of one write-off by its key', () => {
    expect(writeOffGroupOf('inventory.writeOff:abc:def:12')).toBe('inventory.writeOff:abc:def')
    expect(writeOffGroupOf('inventory.writeOff:abc')).toBeNull()
    expect(writeOffGroupOf('inventory.scrap:abc:1')).toBeNull()
  })

  it('takes a hide whole and anything else by quantity from one location', () => {
    expect(writeOffLineProblems([{ hideId: 'h1' }, { fromLocationId: 'l1', quantity: '2' }])).toEqual([])
    expect(writeOffLineProblems([{ hideId: 'h1', quantity: '3' }, { quantity: '2' }, { fromLocationId: 'l1' }, { hideId: 'h1' }]).map((issue) => issue.path)).toEqual([
      'lines/0/quantity',
      'lines/1/fromLocationId',
      'lines/2/quantity',
      'lines/3/hideId',
    ])
    expect(writeOffLineProblems([])).toEqual([{ path: 'lines', message: 'Write off at least one line.' }])
  })

  it('needs an active reason, and the note when the reason needs detail', () => {
    expect(writeOffReasonProblem(null, 'x')?.path).toBe('reasonCode')
    expect(writeOffReasonProblem({ active: false, needsDetail: false }, 'x')?.path).toBe('reasonCode')
    expect(writeOffReasonProblem({ active: true, needsDetail: true }, ' ')?.path).toBe('note')
    expect(writeOffReasonProblem({ active: true, needsDetail: false }, null)).toBeNull()
  })
})
