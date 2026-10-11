import { describe, expect, it } from 'vitest'
import { historyLines, stateOf, undoOf, whoHref, whoOf, type FeedRow } from './historyModel'

const NOW = Date.parse('2026-10-10T12:00:00Z')

let n = 0
const change = (at: string, from: number | null, to: number, over: Partial<FeedRow> = {}): FeedRow => ({
  id: `h:${++n}`,
  at,
  source: 'automation',
  origin: { kind: 'job', id: null, name: 'Brain' },
  field: 'bid',
  oldValue: from == null ? null : String(from),
  newValue: String(to),
  delivery: { state: 'APPLIED', attempts: 1, lastError: null },
  undoable: true,
  undoActionLogId: `a:${n}`,
  ...over,
})

describe('who, and what became of it', () => {
  it('names a person\'s change You, an automatic one by its writer, the brain Brain', () => {
    expect(whoOf({ source: 'operator', origin: { kind: 'manual', id: null, name: 'user:x' } })).toEqual({ kind: 'person', id: null, name: 'You' })
    expect(whoOf({ source: 'automation', origin: { kind: 'schedule', id: 's1', name: 'Jacket hours' } })).toEqual({ kind: 'plan', id: 's1', name: 'Jacket hours' })
    expect(whoOf({ source: 'automation', origin: { kind: 'rule', id: 'r1', name: 'Cut losers' } })).toEqual({ kind: 'rule', id: 'r1', name: 'Cut losers' })
    expect(whoOf({ source: 'automation', origin: { kind: 'job', id: null, name: 'bid brain' } })).toEqual({ kind: 'brain', id: 'brain', name: 'Brain' })
    expect(whoOf({ source: 'automation', origin: { kind: 'unknown', id: null, name: 'unknown' } }).name).toBe('Automation')
  })

  it('links a rule\'s name to its detail on this page (the Brain opens the panel\'s own Why tab)', () => {
    expect(whoHref({ kind: 'rule', id: 'r1', name: 'Cut losers' }, 'IT')).toBe('/marketing/ads/rules-automation/bid?market=IT&rule=r1&tab=overview')
    expect(whoHref({ kind: 'brain', id: 'brain', name: 'Brain' }, null)).toBeNull()
    expect(whoHref({ kind: 'person', id: null, name: 'You' }, 'IT')).toBeNull()
    expect(whoHref({ kind: 'plan', id: 's1', name: 'Jacket hours' }, 'IT')).toBeNull()
  })

  it('says what became of a change in the page\'s one word set, Undone included; no record is not success', () => {
    expect(stateOf({ delivery: { state: 'APPLIED', lastError: null } })).toBe('live')
    expect(stateOf({ delivery: { state: 'PENDING', lastError: null } })).toBe('waiting')
    expect(stateOf({ delivery: { state: 'FAILED', lastError: 'x' } })).toBe('failed')
    expect(stateOf({ delivery: { state: 'APPLIED', lastError: null }, undoBlockedReason: 'Already undone.' })).toBe('undone')
    expect(stateOf({ delivery: null })).toBeNull()
  })
})

describe('undo', () => {
  it('offers Undo only where the feed gives the handle, else "Can\'t undo" and why', () => {
    expect(undoOf({ at: '2026-10-10T11:00:00Z', undoable: true, undoActionLogId: 'a1' }, NOW)).toEqual({ kind: 'undo', changeId: 'a1' })
    expect(undoOf({ at: '2026-10-10T11:00:00Z', undoable: false, undoActionLogId: null, undoBlockedReason: 'Never reached Amazon.' }, NOW)).toEqual({ kind: 'cant', word: 'Can\'t undo', reason: 'Never reached Amazon' })
    expect(undoOf({ at: '2026-10-08T11:00:00Z', undoable: false, undoActionLogId: null }, NOW)).toEqual({ kind: 'cant', word: 'Can\'t undo', reason: 'Only within 24 h' })
    expect(undoOf({ at: '2026-10-10T11:00:00Z', undoable: false, undoActionLogId: 'a1' }, NOW).kind).toBe('cant')
  })
})

describe('the night floor folded', () => {
  it('folds a floor and its give-back to the same bid into nothing', () => {
    const rows = [change('2026-10-09T22:00:00Z', 15, 2), change('2026-10-10T06:00:00Z', 2, 15)]
    const out = historyLines(rows, { now: NOW })
    expect(out.lines).toEqual([])
    expect(out.foldedSteps).toBe(2)
  })

  it('folds a floor and a give-back to another bid into one line, without Undo', () => {
    const rows = [change('2026-10-09T22:00:00Z', 18, 2), change('2026-10-10T06:00:00Z', 2, 15)]
    const out = historyLines(rows, { now: NOW })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toMatchObject({ from: 18, to: 15, folded: true, state: 'live' })
    expect(out.lines[0].undo.kind).toBe('cant')
    expect(out.foldedSteps).toBe(1)
  })

  it('keeps a person\'s change and a floor still on tonight, newest first', () => {
    const rows = [
      change('2026-10-09T08:00:00Z', 10, 12, { source: 'operator', origin: { kind: 'manual', id: null, name: 'user:x' } }),
      change('2026-10-09T22:00:00Z', 12, 2),
      change('2026-10-10T06:00:00Z', 2, 12),
      change('2026-10-10T22:00:00Z', 12, 2),
    ]
    const out = historyLines(rows, { now: Date.parse('2026-10-10T23:00:00Z') })
    expect(out.lines.map((l) => [l.from, l.to, l.who.name])).toEqual([[12, 2, 'Brain'], [10, 12, 'You']])
    expect(out.foldedSteps).toBe(2)
  })

  it('shows every step when asked, newest first', () => {
    const rows = [change('2026-10-09T22:00:00Z', 15, 2), change('2026-10-10T06:00:00Z', 2, 15)]
    const out = historyLines(rows, { raw: true, now: NOW })
    expect(out.lines.map((l) => [l.from, l.to])).toEqual([[2, 15], [15, 2]])
  })

  it('never folds a person\'s low bid, and leaves out what is not a bid', () => {
    const rows = [
      change('2026-10-10T08:00:00Z', 15, 5, { source: 'operator', origin: { kind: 'manual', id: null, name: 'user:x' } }),
      change('2026-10-10T09:00:00Z', null, 0, { field: 'status', newValue: 'PAUSED' }),
    ]
    const out = historyLines(rows, { now: NOW })
    expect(out.lines.map((l) => [l.from, l.to, l.who.name])).toEqual([[15, 5, 'You']])
  })
})
