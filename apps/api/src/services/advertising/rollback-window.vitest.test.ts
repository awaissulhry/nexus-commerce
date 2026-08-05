/**
 * ACR.4.3 — how long a single action stays reversible.
 *
 * This is a SAFETY rule, not a formatting one: it decides whether the console offers to write an
 * old value back to Amazon. The case that matters is the one Stage 4's plan asked for literally
 * and this rule deliberately refuses — a flat seven days on bids, which the rank engine
 * supersedes hourly.
 */
import { describe, it, expect } from 'vitest'
import { rollbackWindowMsFor, rollbackWindowLabel, ROLLBACK_WINDOW_HOURS } from './rollback.service.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('bids stay at 24 hours', () => {
  it('a bid write', () => {
    expect(rollbackWindowMsFor('AD_BID_UPDATE')).toBe(DAY)
    expect(rollbackWindowLabel('AD_BID_UPDATE')).toBe('24-hour')
  })

  /**
   * The whole point of the per-class rule. The rank engine re-evaluates hourly, so a bid from
   * six days ago has been overwritten ~150 times; restoring it is not an undo, it is a new and
   * uninformed decision. Same reasoning as ADS_STALE_INTENT_MS in the delivery model.
   */
  it('is NOT extended to seven days', () => {
    expect(rollbackWindowMsFor('AD_BID_UPDATE')).toBeLessThan(7 * DAY)
  })
})

describe('budgets and placements get seven days', () => {
  it('budget writes, under both spellings the account uses', () => {
    expect(rollbackWindowMsFor('AD_BUDGET_UPDATE')).toBe(7 * DAY)
    expect(rollbackWindowMsFor('adjust_ad_budget')).toBe(7 * DAY)
  })
  it('placement writes — the rank engine\'s main lever, and reversible by snapshot', () => {
    expect(rollbackWindowMsFor('update_placement_bidding')).toBe(7 * DAY)
    expect(rollbackWindowLabel('update_placement_bidding')).toBe('7-day')
  })
})

describe('the default is the conservative one', () => {
  /**
   * Default-deny, matching ads-graduation's treatment of an unclassified action: something
   * nobody has thought about gets the SHORTER window, not the longer one. The failure mode of
   * being wrong here is offering to rewrite Amazon from a stale snapshot.
   */
  it('an unknown action type falls back to 24h', () => {
    expect(rollbackWindowMsFor('some_future_action')).toBe(DAY)
    expect(rollbackWindowMsFor('')).toBe(DAY)
  })
  it('a create is not silently long-windowed', () => {
    expect(rollbackWindowMsFor('bulksheet_create_keyword')).toBe(DAY)
  })
  it('the exported hour constant still describes the short window', () => {
    expect(ROLLBACK_WINDOW_HOURS).toBe(24)
  })
})

describe('the label always matches the window it describes', () => {
  it('never says 7-day for a 24h action, or the reverse', () => {
    for (const t of ['AD_BID_UPDATE', 'AD_BUDGET_UPDATE', 'update_placement_bidding', 'adjust_ad_budget', 'whatever']) {
      const isLong = rollbackWindowMsFor(t) === 7 * DAY
      expect(rollbackWindowLabel(t)).toBe(isLong ? '7-day' : '24-hour')
    }
  })
})
