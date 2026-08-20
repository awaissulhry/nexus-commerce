/**
 * ADX N3 — how far a rule may be trusted.
 *
 * The load-bearing cases are the two that stop a bulk "set everything to AUTO":
 * a rule is judged by its most dangerous action, and an unclassified action is
 * refused rather than assumed safe.
 */
import { describe, it, expect } from 'vitest'
import { graduationCeiling, isLevelAllowed } from './ads-graduation.js'

const v = (actionTypes: string[], hasKeywordProtections = false) =>
  graduationCeiling({ actionTypes, hasKeywordProtections })

describe('reversible rules may reach AUTO', () => {
  it('bid adjustment', () => {
    expect(v(['bid_to_target_acos']).maxLevel).toBe('AUTO')
    expect(v(['bid_up', 'bid_down']).maxLevel).toBe('AUTO')
  })
  it('budget adjustment', () => {
    expect(v(['adjust_ad_budget']).maxLevel).toBe('AUTO')
  })
  it('the retail guard — already live, and this must agree', () => {
    expect(v(['retail_guard', 'notify']).maxLevel).toBe('AUTO')
  })
  it('notifications are ignored when judging', () => {
    expect(v(['notify', 'alert_operator']).maxLevel).toBe('AUTO')
    expect(v(['bid_up', 'notify']).maxLevel).toBe('AUTO')
  })
})

describe('structural rules are capped at PROPOSE', () => {
  it('creating a keyword', () => {
    const r = v(['promote_to_exact'])
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.blockedBy).toContain('promote_to_exact')
  })
  it('destroying history', () => {
    expect(v(['archive_keyword']).maxLevel).toBe('PROPOSE')
  })
  it('pausing — the house rule is to suppress with a 2c bid, never to pause', () => {
    expect(v(['pause_campaign']).maxLevel).toBe('PROPOSE')
    expect(v(['pause_all_campaigns']).maxLevel).toBe('PROPOSE')
  })

  it('A RULE IS JUDGED BY ITS MOST DANGEROUS ACTION', () => {
    // Moving a bid back undoes a bid. Nothing undoes a negative you did not notice.
    const r = v(['bid_to_target_acos', 'harvest_and_negate'])
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.blockedBy).toContain('harvest_and_negate')
  })
})

describe('the negation gate', () => {
  it('names the missing whitelist as the reason, because that is the fixable part', () => {
    const r = v(['harvest_and_negate'], false)
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.reason).toMatch(/protected terms/i)
  })

  it('still capped once protections exist — the reason changes, the ceiling does not', () => {
    const r = v(['harvest_and_negate'], true)
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.reason).toMatch(/retirement path/i)
  })
})

describe('unclassified actions are refused, not assumed safe', () => {
  it('default-deny', () => {
    const r = v(['some_new_action_nobody_classified'])
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.blockedBy).toEqual(['some_new_action_nobody_classified'])
    expect(r.reason).toMatch(/classify/i)
  })

  it('one unknown action drags a safe rule down with it', () => {
    expect(v(['bid_up', 'mystery_action']).maxLevel).toBe('PROPOSE')
  })
})

describe('isLevelAllowed', () => {
  it('permits at or below the ceiling', () => {
    expect(isLevelAllowed('PROPOSE', 'AUTO')).toBe(true)
    expect(isLevelAllowed('AUTO', 'AUTO')).toBe(true)
    expect(isLevelAllowed('OBSERVE', 'PROPOSE')).toBe(true)
  })
  it('refuses above it', () => {
    expect(isLevelAllowed('AUTO', 'PROPOSE')).toBe(false)
  })
  it('OFF is always allowed — you can always stop something', () => {
    expect(isLevelAllowed('OFF', 'PROPOSE')).toBe(true)
    expect(isLevelAllowed('OFF', 'OFF')).toBe(true)
  })
})

// P2.4 — builder slugs are judged by what they translate INTO, not left in default-deny.
describe('builder-slug expansion', () => {
  const g = (types: string[], prot = true) => graduationCeiling({ actionTypes: types, hasKeywordProtections: prot })

  it('a budget/placement/sov/keyword-tracker slug reaches AUTO like its *_apply action', () => {
    for (const slug of ['budget', 'placement', 'sov', 'keyword-tracker']) {
      expect(g([slug]).maxLevel, slug).toBe('AUTO')
    }
  })

  /**
   * C2 (2026-08-20, `876a0562a`) — the bid slug now expands to `pause_target`/`enable_target`
   * as well as `bid_apply`, because the builder's THEN list gained Pause/Unpause Target. Pausing
   * a target is STRUCTURAL by the ceiling's own policy (the hardest thing in an account to
   * notice later), so the slug's ceiling correctly dropped AUTO → PROPOSE — the commit is even
   * titled "…the ceiling reason that no longer contradicts it". This test asserted the pre-C2
   * AUTO for a day; it now pins the intended behaviour instead.
   */
  it('the bid slug caps at PROPOSE since C2 — its expansion carries pause_target, which is structural', () => {
    const r = g(['bid'])
    expect(r.maxLevel).toBe('PROPOSE')
    expect(r.blockedBy).toContain('pause_target')
  })

  it('a negation slug is recognised as the negation family, whitelist gate and all', () => {
    const withProtections = g(['negative-targeting'], true)
    expect(withProtections.maxLevel).toBe('PROPOSE')
    expect(withProtections.reason).toMatch(/retirement path/i)
    const without = g(['negative-targeting'], false)
    expect(without.reason).toMatch(/protected terms/i)
  })

  it('a harvest slug is structural — it creates keywords and negatives', () => {
    expect(g(['keyword-harvesting']).maxLevel).toBe('PROPOSE')
  })
})
