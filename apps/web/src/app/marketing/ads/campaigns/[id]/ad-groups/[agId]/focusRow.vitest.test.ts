import { describe, expect, it } from 'vitest'
import { focusText, isFocusRow } from './focusRow'
import { isKeptPaused, keptPausedRefusals, keptPausedWords, withoutRefusals, type HoldFields } from './tabs/keptPaused'

const rows = [{ id: 't1', text: 'rain jacket' }, { id: 't2', text: 'Winter  Gloves' }]

describe('?focus= on the ad group page', () => {
  it('a target id gives its words; words stay words', () => {
    expect(focusText('t1', rows, (r) => r.id, (r) => r.text)).toBe('rain jacket')
    expect(focusText('cheap coat', rows, (r) => r.id, (r) => r.text)).toBe('cheap coat')
    expect(focusText('  ', rows, (r) => r.id, (r) => r.text)).toBeNull()
  })
  it('marks the row by its id or its words, case and spacing aside', () => {
    expect(isFocusRow('t2', 't2', 'x')).toBe(true)
    expect(isFocusRow('winter gloves', 't2', 'Winter  Gloves')).toBe(true)
    expect(isFocusRow('winter', 't2', 'Winter Gloves')).toBe(false)
    expect(isFocusRow(null, 't2', 'Winter Gloves')).toBe(false)
  })
})

describe('kept paused on the Targets tab', () => {
  const kept = { status: 'PAUSED', keptPausedAt: '2026-10-04T10:00:00Z', keptPausedBy: 'user:u1', keptPausedUntil: null, keptPausedReason: 'wastes', expressionValue: 'rain jacket' }
  it('says who keeps it, since when, until when', () => {
    expect(isKeptPaused(kept)).toBe(true)
    expect(isKeptPaused({ status: 'PAUSED' })).toBe(false)
    expect(keptPausedWords(kept)).toBe('Kept paused by a person since 4 Oct · always: only a person turns it on')
    expect(keptPausedWords({ ...kept, keptPausedBy: 'rule:r1', keptPausedUntil: '2026-12-01T10:00:00Z' })).toBe('Kept paused by a rule since 4 Oct · until 1 Dec: only a person turns it on')
  })
  it('a refused turn-on of a kept-paused row becomes the person\'s question; other refusals stay in the toast', () => {
    const res = { done: ['t3'], queued: 0, failed: [{ id: 't1', reason: 'Kept paused by user:u1 since 2026-10-04' }, { id: 't2', reason: 'Amazon refused it.' }] }
    const map = new Map<string, HoldFields & { expressionValue?: string }>([['t1', kept], ['t2', { status: 'PAUSED', expressionValue: 'gloves' }]])
    const asks = keptPausedRefusals(res, map)
    expect(asks).toEqual([{ id: 't1', text: 'rain jacket', reason: 'Kept paused by a person since 4 Oct, 12:00 (always). Turning it on lets it spend.' }])
    // The person signed in reads "You"; never a raw id, never UTC, never a tool name.
    expect(keptPausedRefusals(res, map, 'u1')[0].reason).toBe('Kept paused by You since 4 Oct, 12:00 (always). Turning it on lets it spend.')
    expect(JSON.stringify(keptPausedRefusals(res, map, 'u1'))).not.toMatch(/user:|UTC|release|enable-ads/)
    expect(withoutRefusals(res, new Set(['t1'])).failed).toEqual([{ id: 't2', reason: 'Amazon refused it.' }])
  })
})
