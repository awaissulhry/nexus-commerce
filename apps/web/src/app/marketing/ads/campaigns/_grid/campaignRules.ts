/**
 * AM-12 / AM-24 — the rules that may act on one Ad Manager row, from ONE place.
 *
 * The Rules column printed "account-wide + bound" (e.g. 20) while the dialog it opens said, hard-coded, "0 Rules · No
 * rules are applied", and the "Rule" filter (Has rules / No rules) filtered nothing. The cell, the dialog and the
 * filter now all read `ruleReach`, so they cannot disagree.
 *
 * What counts (the Control Room's guardrail grid supplies both halves):
 *   · bound       — rules dropped on THIS campaign, switched on. A bound rule that is switched off is listed apart and
 *                   not counted: it cannot act.
 *   · account-wide — switched-on rules that name no campaign and no portfolio. One that names a market reaches only
 *                   that market's campaigns, so it is counted only there (the rule engine matches it the same way).
 * A rule's own settings (a picked campaign list, a product) can still narrow it; the dialog says so.
 */

export interface BoundRule { id: string; name: string; level: string; enabled: boolean }
export interface AccountWideRule { id: string; name: string; level: string; scopeMarketplace: string | null }

export interface RuleReach {
  /** Switched-on rules bound to this campaign. */
  bound: BoundRule[]
  /** Bound to this campaign but switched off: listed, not counted. */
  boundOff: BoundRule[]
  /** Account-wide rules that reach this campaign's market; null when the API sent only a count (older API). */
  accountWide: AccountWideRule[] | null
  accountWideCount: number
  total: number
}

export function ruleReach(input: {
  marketplace: string | null | undefined
  boundRules?: readonly BoundRule[] | null
  accountWideList?: readonly AccountWideRule[] | null
  accountWideCount?: number | null
}): RuleReach {
  const bound = (input.boundRules ?? []).filter((r) => r.enabled)
  const boundOff = (input.boundRules ?? []).filter((r) => !r.enabled)
  const accountWide = input.accountWideList
    ? input.accountWideList.filter((r) => !r.scopeMarketplace || r.scopeMarketplace === input.marketplace)
    : null
  const accountWideCount = accountWide ? accountWide.length : (input.accountWideCount ?? 0)
  return { bound, boundOff, accountWide, accountWideCount, total: accountWideCount + bound.length }
}

/** AM-24 — the filter bar's "Bid Automation": '' = all, 'on', 'off'. */
export function matchesBidAutomation(filter: string, bidAutomation: boolean | null | undefined): boolean {
  if (filter === 'on') return bidAutomation === true
  if (filter === 'off') return bidAutomation !== true
  return true
}

/**
 * AM-24 — the filter bar's "Rule": '' = all, 'has', 'none'. `reach` is null while the rule data is still loading; the
 * filter then keeps every row rather than guessing.
 */
export function matchesRuleFilter(filter: string, reach: RuleReach | null): boolean {
  if (!filter || reach == null) return true
  if (filter === 'has') return reach.total > 0
  if (filter === 'none') return reach.total === 0
  return true
}
