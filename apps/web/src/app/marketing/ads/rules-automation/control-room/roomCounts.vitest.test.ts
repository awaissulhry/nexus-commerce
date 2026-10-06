/**
 * CR rebuild 1 — the top tiles: the three automation tiles always add up to the Who acts count, and Waiting for you
 * counts every queue that holds a decision for a person (the old tile said 0 while Approvals held two requests).
 */
import { describe, expect, it } from 'vitest'
import { problemHint, problemRows, quietHint, ruleInForce, suggestionsWaiting, waitingFor, type AccountLevel, type ProblemRow } from './roomCounts'

const g = (over: Partial<AccountLevel> = {}): AccountLevel => ({ autonomy: 'AUTO', halted: false, envKill: false, ...over })

describe('a rule’s level in force', () => {
  it('a stop, the server switch and the level at Off hold every rule off', () => {
    expect(ruleInForce('AUTO', g({ halted: true }))).toBe('OFF')
    expect(ruleInForce('AUTO', g({ envKill: true }))).toBe('OFF')
    expect(ruleInForce('PROPOSE', g({ autonomy: 'OFF' }))).toBe('OFF')
  })
  it('Ask me holds Auto at asking and leaves lower levels as they are', () => {
    expect(ruleInForce('AUTO', g({ autonomy: 'SUGGEST' }))).toBe('PROPOSE')
    expect(ruleInForce('OBSERVE', g({ autonomy: 'SUGGEST' }))).toBe('OBSERVE')
    expect(ruleInForce('AUTO', g())).toBe('AUTO')
  })
})

describe('the quiet tile', () => {
  it('the quiet hint names only the parts that have one', () => {
    expect(quietHint({ watch: 1, off: 2, idle: 1 })).toBe('1 watch · 2 off · 1 on, nothing to change')
    expect(quietHint({ watch: 0, off: 3, idle: 0 })).toBe('3 off')
    expect(quietHint({ watch: 0, off: 0, idle: 0 })).toBe('none')
  })
})

describe('Waiting for you', () => {
  it('THE REGRESSION: Claude requests in Approvals count, beside the rule suggestions', () => {
    expect(waitingFor(2, 0)).toEqual({ value: 2, hint: '2 in Approvals (all of Nexus) · 0 rule suggestions' })
    expect(waitingFor(2, 1)).toEqual({ value: 3, hint: '2 in Approvals (all of Nexus) · 1 rule suggestion' })
  })
  it('an unread side is said, never shown as 0; both unread is unknown', () => {
    expect(waitingFor(null, 3)).toEqual({ value: 3, hint: 'Approvals could not be read · 3 rule suggestions' })
    expect(waitingFor(1, null)).toEqual({ value: 1, hint: '1 in Approvals (all of Nexus) · rule suggestions could not be read' })
    expect(waitingFor(null, null)).toEqual({ value: null, hint: 'Could not be read' })
  })
  it('rule suggestions come from the Today board; no row means none waiting, no board means unknown', () => {
    expect(suggestionsWaiting([{ key: 'decisions-waiting', severity: 'info', count: 4 }])).toBe(4)
    expect(suggestionsWaiting([{ key: 'wasted-spend', severity: 'warning', count: 9 }])).toBe(0)
    expect(suggestionsWaiting(null)).toBeNull()
  })
})

describe('Problems', () => {
  const rows: ProblemRow[] = [
    { key: 'automation-stopped', severity: 'critical', count: 1 },
    { key: 'decisions-waiting', severity: 'warning', count: 4 },
    { key: 'failed-mutations', severity: 'critical', count: 2 },
    { key: 'no-cost-data', severity: 'warning', count: 5 },
    { key: 'graduation', severity: 'info', count: 1 },
  ]
  it('leave out what the top band and Waiting for you already show', () => {
    expect(problemRows(rows)?.map((r) => r.key)).toEqual(['failed-mutations', 'no-cost-data', 'graduation'])
    expect(problemRows(null)).toBeNull()
  })
  it('the hint counts each severity with the right verb', () => {
    expect(problemHint(problemRows(rows)!)).toBe('1 critical · 1 needs attention · 1 worth knowing')
    expect(problemHint([{ key: 'a', severity: 'warning', count: 1 }, { key: 'b', severity: 'warning', count: 1 }])).toBe('2 need attention')
    expect(problemHint([])).toBe('Nothing needs you')
  })
})
