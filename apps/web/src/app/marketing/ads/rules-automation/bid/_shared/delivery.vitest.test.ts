import { describe, expect, it } from 'vitest'
import { CANT_UNDO, CHANGE_STATE_TONE, CHANGE_STATE_WORD, CHANGE_STATES, changeStateOf, changeStateView, undoView } from './delivery'

describe('what became of a change: one word, one tone', () => {
  it('maps every feed state to one of seven words', () => {
    expect(changeStateOf({ delivery: 'PENDING' })).toBe('waiting')
    expect(changeStateOf({ delivery: 'IN_FLIGHT' })).toBe('sent')
    expect(changeStateOf({ delivery: 'APPLIED' })).toBe('live')
    expect(changeStateOf({ delivery: 'SUCCESS' })).toBe('live')
    expect(changeStateOf({ delivery: 'LANDED' })).toBe('live')
    expect(changeStateOf({ delivery: 'FAILED' })).toBe('failed')
    expect(changeStateOf({ delivery: 'REFUSED' })).toBe('failed')
    expect(changeStateOf({ delivery: 'CANCELLED' })).toBe('cancelled')
    expect(changeStateOf({ delivery: 'SKIPPED' })).toBe('cancelled')
    expect(changeStateOf({ delivery: 'SUPERSEDED' })).toBe('replaced')
  })

  it('says Undone for a change put back since, whatever its delivery', () => {
    expect(changeStateOf({ delivery: 'APPLIED', undoBlocked: 'Already undone.' })).toBe('undone')
    expect(changeStateOf({ delivery: 'APPLIED', reason: 'rolled back' })).toBe('undone')
  })

  it('never reads no record as success', () => {
    expect(changeStateOf({ delivery: null })).toBeNull()
    expect(changeStateView({ delivery: null })).toEqual({ state: null, word: '—', tone: 'neutral' })
  })

  it('has a word and a tone for every state', () => {
    expect(CHANGE_STATES.map((s) => CHANGE_STATE_WORD[s])).toEqual(['Queued', 'Sent', 'Live', 'Undone', 'Failed', 'Cancelled', 'Replaced'])
    expect(CHANGE_STATE_TONE.live).toBe('success')
    expect(CHANGE_STATE_TONE.failed).toBe('danger')
    expect(changeStateView({ delivery: 'APPLIED' })).toEqual({ state: 'live', word: 'Live', tone: 'success' })
  })
})

describe('undo: the handle, or "Can\'t undo" with its reason', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')

  it('offers the change\'s own handle', () => {
    expect(undoView({ changeId: 'a1' }, now)).toEqual({ kind: 'undo', changeId: 'a1' })
  })

  it('says the server\'s reason, else the 24-hour window, else plain words', () => {
    expect(undoView({ changeId: null, undoBlocked: 'Already undone.' }, now)).toEqual({ kind: 'cant', word: CANT_UNDO, reason: 'Already undone' })
    expect(undoView({ changeId: null, at: '2026-10-08T12:00:00Z' }, now)).toEqual({ kind: 'cant', word: CANT_UNDO, reason: 'Only within 24 h' })
    expect(undoView({ changeId: null, at: '2026-10-10T11:00:00Z' }, now)).toEqual({ kind: 'cant', word: CANT_UNDO, reason: 'This change has no undo' })
  })
})
