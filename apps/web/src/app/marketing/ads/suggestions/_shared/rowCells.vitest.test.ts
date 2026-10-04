/**
 * 4i (review 4.7) — a Placement rule runs on the budget trigger by design (PLC-P7), so its proposals' signal read
 * "Budget performance". The suggestion's family (the server's one map) names it instead.
 */
import { describe, expect, it } from 'vitest'
import { prettyTrigger } from './rowCells'

describe('prettyTrigger — the Signal and Reason fallback', () => {
  it('🔴 a placement proposal on the budget trigger reads "Placement performance"', () => {
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET', 'placement')).toBe('Placement performance')
  })

  it('a budget proposal on the same trigger, or one with no family, keeps the trigger\'s own words', () => {
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET', 'budget')).toBe('Budget performance')
    expect(prettyTrigger('CAMPAIGN_PERFORMANCE_BUDGET')).toBe('Budget performance')
    expect(prettyTrigger('KEYWORD_HIGH_ACOS', 'placement')).toBe('High ACoS keyword')
    expect(prettyTrigger(null, 'placement')).toBe('Rule match')
  })
})
