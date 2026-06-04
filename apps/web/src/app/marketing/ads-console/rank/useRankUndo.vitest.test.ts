import { describe, it, expect } from 'vitest'
import { pickUndoTarget, fmtEur, type HistEntry } from './rank-undo-logic'

const E = (over: Partial<HistEntry>): HistEntry => ({
  id: 'x', at: '2026-06-04T00:00:00Z', actor: 'you', entityType: 'AD_TARGET', entityId: 't1',
  field: 'bid', oldValue: '50', newValue: '25', reason: null, isUndo: false, undoable: true, ...over,
})

// RC4.10 — sequential undo target selection (the brain behind Cmd+Z).
describe('pickUndoTarget', () => {
  it('picks the most-recent undoable change (entries are newest-first)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })]
    expect(pickUndoTarget(entries, new Set())?.id).toBe('a')
  })

  it('skips undo()\'s own reverse entries (isUndo) so it walks back through real changes', () => {
    const entries = [E({ id: 'rev', isUndo: true }), E({ id: 'real' })]
    expect(pickUndoTarget(entries, new Set())?.id).toBe('real')
  })

  it('skips entries already consumed this session', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })]
    expect(pickUndoTarget(entries, new Set(['a']))?.id).toBe('b')
  })

  it('skips non-undoable changes (e.g. placement-% or >24h)', () => {
    const entries = [E({ id: 'placement', undoable: false }), E({ id: 'bid' })]
    expect(pickUndoTarget(entries, new Set())?.id).toBe('bid')
  })

  it('returns null when nothing qualifies', () => {
    expect(pickUndoTarget([E({ undoable: false }), E({ isUndo: true })], new Set())).toBeNull()
    expect(pickUndoTarget([], new Set())).toBeNull()
  })

  it('walks back sequentially as targets are consumed', () => {
    const entries = [E({ id: 'c' }), E({ id: 'b' }), E({ id: 'a' })]
    const consumed = new Set<string>()
    const first = pickUndoTarget(entries, consumed)!; expect(first.id).toBe('c'); consumed.add(first.id)
    const second = pickUndoTarget(entries, consumed)!; expect(second.id).toBe('b'); consumed.add(second.id)
    expect(pickUndoTarget(entries, consumed)?.id).toBe('a')
  })
})

describe('fmtEur', () => {
  it('formats cents as euros', () => {
    expect(fmtEur(50)).toBe('€0.50')
    expect(fmtEur(2500)).toBe('€25.00')
    expect(fmtEur(0)).toBe('€0.00')
  })
})
