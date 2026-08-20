/**
 * D3a — the Budget-rules modal's filtering, per the design handoff.
 *
 * Extracted from the dialog because it is the one part with real logic and therefore the one part
 * worth testing: query and segment **compose (AND)**, and the query matches the concatenation of
 * `name + condition + delta` so typing `50` finds `ACoS ≥ 50%`. Verified against the handoff's own
 * prototype before writing it — searching "50" there returns both `ACoS ≥ 50%` and
 * `ACoS ≥ 40% and Spend ≥ €50`, i.e. it matches thresholds inside the criteria, not just names.
 *
 * No debounce: the handoff sets that threshold at ~200 rules and this account has six.
 */
export type RuleSegment = 'all' | 'on' | 'AUTO' | 'PROPOSE'

export interface FilterableRule {
  id: string
  name: string
  /** the rule's own mode, independent of whether it is assigned here */
  level: string
  /** pre-formatted, e.g. 'ACoS ≥ 50%' */
  condition: string
  /** pre-formatted, e.g. '−20%' */
  delta: string
}

export function filterBudgetRules<T extends FilterableRule>(
  rules: T[],
  query: string,
  segment: RuleSegment,
  isAssigned: (id: string) => boolean,
): T[] {
  const q = query.trim().toLowerCase()
  return rules.filter((r) => {
    // Segment first — it is the cheaper test and the more common narrowing.
    if (segment === 'on' && !isAssigned(r.id)) return false
    if ((segment === 'AUTO' || segment === 'PROPOSE') && r.level !== segment) return false
    if (q === '') return true
    return `${r.name} ${r.condition} ${r.delta}`.toLowerCase().includes(q)
  })
}
