/**
 * SHEET-VIEWS step 5 (Owner-approved 2026-09-26) — a saved view that FOLLOWS a rule, not only a key list.
 *
 * A columns view names its columns (`columns`). That is exact, and it is frozen: an attribute a channel
 * adds next month joins no saved view, because nobody could tick a column that did not exist. A rule is
 * the other half. It is stored beside the keys and resolved when the view is APPLIED, so a new attribute
 * in a followed group, or a newly required one, is on screen without anyone editing the view.
 *
 * Three rules, each one a fact the sheet already shows:
 *   group     every column in one group — stored when a group is FULLY ticked at save time
 *   required  every column some channel requires on these rows (the Required preset)
 *   gaps      every column with a readiness gap on a row in view (the Has gaps preset)
 *
 * Additive, like `ViewDisplay`: `rules` is optional, no schema number moves, and a view without it reads
 * exactly as before. A rule only ADDS columns — the stored keys still show, so a rule can never hide a
 * column the operator chose.
 *
 * Pure — no AG, no React. Tested in `viewRules.vitest.test.ts`.
 */
import type { PreferencesColumnSpec, PreferencesValue } from '../../patterns/PreferencesModal'
import { resolveAttributeGroups } from '../../patterns/preferencesLogic'
import type { ColumnsViewPayload } from './viewPayload'

export type ViewRule =
  | { kind: 'group'; group: string }
  | { kind: 'required' }
  | { kind: 'gaps' }

export const VIEW_RULES_MAX = 200

/** The row-dependent facts a rule reads. The sheet supplies them; the DS knows only the groups. */
export interface ViewRuleFacts {
  required: ReadonlySet<string>
  gaps: ReadonlySet<string>
}

/**
 * The rules a stored payload carries, CHECKED: an entry this build does not understand is dropped, not
 * guessed at. The server refuses a bad write (`validateSavedViewPayload`); this is the read side.
 */
export function viewRulesOf(payload: unknown): ViewRule[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const rules = (payload as { rules?: unknown }).rules
  if (!Array.isArray(rules)) return []
  const seen = new Set<string>()
  const out: ViewRule[] = []
  for (const raw of rules.slice(0, VIEW_RULES_MAX)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { kind?: unknown; group?: unknown }
    const rule: ViewRule | null = r.kind === 'group' && typeof r.group === 'string' && r.group.trim() ? { kind: 'group', group: r.group.trim() }
      : r.kind === 'required' ? { kind: 'required' }
      : r.kind === 'gaps' ? { kind: 'gaps' }
      : null
    if (!rule || seen.has(ruleId(rule))) continue
    seen.add(ruleId(rule))
    out.push(rule)
  }
  return out
}

const ruleId = (rule: ViewRule) => (rule.kind === 'group' ? `group:${rule.group}` : rule.kind)

/** The columns a rule matches NOW, in the registry's group order. Group membership honours the view's own group moves. */
export function viewRuleMatches(rule: ViewRule, specs: readonly PreferencesColumnSpec[], value: PreferencesValue, facts: ViewRuleFacts): string[] {
  const groups = resolveAttributeGroups(specs, value)
  const ordered = groups.flatMap((g) => g.columns.map((c) => c.key))
  if (rule.kind === 'group') return groups.find((g) => g.key === rule.group)?.columns.map((c) => c.key) ?? []
  const set = rule.kind === 'required' ? facts.required : facts.gaps
  return ordered.filter((key) => set.has(key))
}

/**
 * The payload as it applies HERE: its own keys plus whatever its rules match on this product type today.
 * A rule never removes a key, and a view with no rules comes back unchanged (the same object).
 */
export function withViewRules<P extends ColumnsViewPayload>(payload: P, specs: readonly PreferencesColumnSpec[], value: PreferencesValue, facts: ViewRuleFacts): P {
  const rules = viewRulesOf(payload)
  if (!rules.length) return payload
  const columns = [...new Set([...payload.columns, ...rules.flatMap((rule) => viewRuleMatches(rule, specs, value, facts))])]
  return columns.length > payload.columns.length ? { ...payload, columns } : payload
}

/**
 * The rules a SAVE stores, from what is on screen.
 *
 * - A fact rule (`required`, `gaps`) is kept when it is offered — the view already follows it, or its
 *   preset is the one applied — and every column it matches is still visible. Untick one of them and the
 *   operator has said "not all of these", so the rule goes and the ticked keys stay.
 * - A group rule is stored for every group whose columns are ALL visible, unless a kept fact rule already
 *   covers that whole group: a Required view must not start following "Identity" because every Identity
 *   column happens to be required today.
 */
export function viewRulesFor(
  value: PreferencesValue,
  specs: readonly PreferencesColumnSpec[],
  facts: ViewRuleFacts,
  offered: readonly ViewRule[] = [],
): ViewRule[] {
  const visible = new Set([...value.visibleColumns, ...(value.lockedColumns ?? [])])
  const factRules = viewRulesOf({ rules: offered }).filter((rule) => {
    if (rule.kind === 'group') return false
    const matches = viewRuleMatches(rule, specs, value, facts)
    return matches.length > 0 && matches.every((key) => visible.has(key))
  })
  const covered = new Set(factRules.flatMap((rule) => viewRuleMatches(rule, specs, value, facts)))
  const groupRules: ViewRule[] = resolveAttributeGroups(specs, value)
    .filter((g) => g.columns.length > 0 && g.columns.every((c) => visible.has(c.key)) && !g.columns.every((c) => covered.has(c.key)))
    .map((g) => ({ kind: 'group', group: g.key }))
  return [...factRules, ...groupRules]
}

/** One line for the views menu: what a view follows, in words (a new column there joins it). Empty when it follows nothing. */
export function describeViewRules(rules: readonly ViewRule[], specs: readonly PreferencesColumnSpec[], value: PreferencesValue): string {
  if (!rules.length) return ''
  const labels = new Map(resolveAttributeGroups(specs, value).map((g) => [g.key, g.label]))
  const groups = rules.flatMap((rule) => (rule.kind === 'group' ? [labels.get(rule.group) ?? rule.group] : []))
  const parts = [
    ...(rules.some((rule) => rule.kind === 'required') ? ['required fields'] : []),
    ...(rules.some((rule) => rule.kind === 'gaps') ? ['fields with gaps'] : []),
    ...(groups.length === 0 ? [] : groups.length === labels.size && labels.size > 1 ? ['every group'] : groups.length > 3 ? [`${groups.length} groups`] : [groups.length === 1 ? `the ${groups[0]} group` : `the ${groups.join(', ')} groups`]),
  ]
  return `Follows ${parts.join(', ')}`
}
