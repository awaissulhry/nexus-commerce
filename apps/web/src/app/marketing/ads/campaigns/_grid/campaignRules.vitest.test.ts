/**
 * AM-12 / AM-24 — the Rules cell, the Campaign Rules dialog and the Rule filter read ONE count.
 *
 * Before: the cell printed account-wide + bound (20), the dialog said a hard-coded "0 Rules · No rules are applied",
 * and the filter bar's "Rule" and "Bid Automation" accepted a choice and filtered nothing. Fake ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchesBidAutomation, matchesRuleFilter, ruleReach, type AccountWideRule, type BoundRule } from './campaignRules'

const ACCOUNT_WIDE: AccountWideRule[] = [
  { id: 'r-1', name: 'Cut bids on high ACoS', level: 'PROPOSE', scopeMarketplace: null },
  { id: 'r-2', name: 'Raise winners', level: 'AUTO', scopeMarketplace: null },
  { id: 'r-3', name: 'DE only budget trim', level: 'PROPOSE', scopeMarketplace: 'DE' },
]
const BOUND: BoundRule[] = [
  { id: 'b-1', name: 'Hero campaign guard', level: 'AUTO', enabled: true },
  { id: 'b-2', name: 'Old test rule', level: 'OFF', enabled: false },
]

describe('ruleReach — what the Rules column counts is what its dialog lists', () => {
  it('counts the account-wide rules of the row\'s market plus the switched-on bound rules', () => {
    const it_ = ruleReach({ marketplace: 'IT', boundRules: BOUND, accountWideList: ACCOUNT_WIDE, accountWideCount: 3 })
    expect(it_.accountWide?.map((r) => r.id)).toEqual(['r-1', 'r-2'])
    expect(it_.bound.map((r) => r.id)).toEqual(['b-1'])
    expect(it_.boundOff.map((r) => r.id)).toEqual(['b-2'])
    expect(it_.total).toBe(3)
    // The listed rows ARE the count: the dialog renders bound + accountWide, the cell prints total.
    expect(it_.bound.length + (it_.accountWide?.length ?? 0)).toBe(it_.total)
  })

  it('a rule that names one market reaches only that market\'s campaigns', () => {
    expect(ruleReach({ marketplace: 'DE', accountWideList: ACCOUNT_WIDE, accountWideCount: 3 }).total).toBe(3)
    expect(ruleReach({ marketplace: 'FR', accountWideList: ACCOUNT_WIDE, accountWideCount: 3 }).total).toBe(2)
  })

  it('an older API that sends only the number still counts it (names unknown, never "0 rules")', () => {
    const r = ruleReach({ marketplace: 'IT', boundRules: [], accountWideList: null, accountWideCount: 20 })
    expect(r.accountWide).toBeNull()
    expect(r.total).toBe(20)
  })

  it('no rule at all is a real 0', () => {
    expect(ruleReach({ marketplace: 'IT', boundRules: [], accountWideList: [], accountWideCount: 0 }).total).toBe(0)
  })
})

describe('AM-24 — the two filters filter', () => {
  it('Bid Automation: On keeps switched-on rows, Off keeps the rest, All keeps every row', () => {
    expect([true, false, undefined].map((v) => matchesBidAutomation('on', v))).toEqual([true, false, false])
    expect([true, false, undefined].map((v) => matchesBidAutomation('off', v))).toEqual([false, true, true])
    expect([true, false, undefined].map((v) => matchesBidAutomation('', v))).toEqual([true, true, true])
  })

  it('Rule: Has rules / No rules read the same total as the column; while loading nothing is dropped', () => {
    const some = ruleReach({ marketplace: 'IT', boundRules: BOUND, accountWideList: ACCOUNT_WIDE })
    const none = ruleReach({ marketplace: 'IT', boundRules: [], accountWideList: [] })
    expect([matchesRuleFilter('has', some), matchesRuleFilter('has', none)]).toEqual([true, false])
    expect([matchesRuleFilter('none', some), matchesRuleFilter('none', none)]).toEqual([false, true])
    expect(matchesRuleFilter('has', null)).toBe(true)
    expect(matchesRuleFilter('', some)).toBe(true)
  })
})

/** The grid itself: the source must route the cell, the dialog and the filters through these readers. */
const SRC = readFileSync(fileURLToPath(new URL('../CampaignsGrid.tsx', import.meta.url)), 'utf8')
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('CampaignsGrid wiring', () => {
  it('the Campaign Rules dialog has no hard-coded "0 Rules" any more', () => {
    expect(CODE).not.toContain('>0 Rules<')
    expect(CODE).not.toContain('No rules are applied to this campaign yet')
    expect(CODE).toMatch(/<CampaignRulesModal campaign=\{rulesModal\} reach=\{reachOf\(rulesModal\)\}/)
  })

  it('the filtered rows read both filters, and both count as active filters', () => {
    expect(CODE).toContain('matchesBidAutomation(bidAutoFilter, c.bidAutomation)')
    expect(CODE).toContain('matchesRuleFilter(ruleFilter, reachOf(c))')
    expect(CODE).toMatch(/hasActiveFilters = [^\n]*!!bidAutoFilter \|\| !!ruleFilter/)
  })

  it('AM-13 — the Bid Automation header no longer promises automation that does not run', () => {
    expect(CODE).not.toContain('Active will automate the keyword bid suggestions')
    expect(CODE).toMatch(/bidAutomation: '[^']*Not running yet/)
  })
})
