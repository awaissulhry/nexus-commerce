import { EMPTY_ITEM_RULES, ITEM_RULE_LIMITS, itemRuleProblems, LOT_SIZINGS, mergeItemRules, PLAN_LEVEL_ITEM_KINDS, PLAN_LEVELS, scrapYieldFactor, type ItemRulePatch, type ItemRuleValues, type LotSizing, type PlanLevel } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { DEFAULT_SIZE_RUN, mergeSizeRun, SIZE_RUN_LIMITS, sizeRunProblems, type SizeRunValues } from '@nexus/factory-domain/planning/lot-sizing/size-run'
import type { SizeRunRule } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { ItemParameters, PlanningSettings } from '../api'

/**
 * B-W2b-335 — Planning settings › Item parameters, the W2b cells (design planning.settings sec:items "lot-sizing (W2b), plan
 * by size/colour/style (W2b)"; B-W2b-318's seven fields on the item parameters routes) and the site's size-run rule the
 * "site's rule" plan level means, pure: a row's rules, what a typed or chosen rule sends — checked with factory-domain's own
 * rules (`mergeItemRules`, `itemRuleProblems`, `sizeRunProblems`) BEFORE anything is sent and refused in our words —, why a
 * plan-level cell is held (a material; no planning.strategy.manage), what the rules do in our words (the API's English
 * `rules` is never drawn). Words are keys of `planning-mrp-depth` (prefix `items.`).
 */

export const ITEM_RULES_NAMESPACE = 'planning-mrp-depth'
export const LOT_SIZING_VALUES = LOT_SIZINGS
export const PLAN_LEVEL_VALUES = PLAN_LEVELS
export const RULE_LIMITS = ITEM_RULE_LIMITS

/** A word of this part: a key of planning-mrp-depth and its values (a value `items.field.<name>` is said as that word). */
export interface RuleWords {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The rule cells: a choice made in a dialog (lot sizing with its number, plan level) or a number typed in the cell. */
export const RULE_NUMBER_FIELDS = ['scrapPct', 'yieldPct', 'delayDays'] as const
export type RuleNumberField = (typeof RULE_NUMBER_FIELDS)[number]
export type RuleField = 'lotSizing' | 'planLevel' | RuleNumberField

/** The rows the API sends carry the seven fields; an older answer (or a made-up row) has none: the defaults. */
export function rulesOf(row: ItemParameters | null): ItemRuleValues | null {
  if (!row) return null
  return {
    lotSizing: (row.lotSizing ?? 'LOT_FOR_LOT') as LotSizing,
    fixedLotQty: row.fixedLotQty ?? null,
    lotPeriodDays: row.lotPeriodDays ?? null,
    planLevel: (row.planLevel ?? null) as PlanLevel | null,
    scrapPct: row.scrapPct ?? null,
    yieldPct: row.yieldPct ?? null,
    delayDays: row.delayDays ?? null,
  }
}

const sameRule = (field: keyof ItemRuleValues, a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null)
  if (field === 'fixedLotQty' || field === 'scrapPct' || field === 'yieldPct') return Number(a) === Number(b)
  return a === b
}

export type RulePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly field: keyof ItemRuleValues; readonly words: RuleWords }
  | { readonly kind: 'write'; readonly patch: ItemRulePatch; readonly values: ItemRuleValues; readonly cleared: readonly (keyof ItemRuleValues)[] }

/** What a change of a row's rules does: nothing (the same), a refusal before sending (in our words, at its field), or the write. */
export function rulesPlan(row: ItemParameters | null, itemKind: string, patch: ItemRulePatch): RulePlan {
  const before = rulesOf(row)
  const named = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof ItemRuleValues, unknown][]
  if (named.length === 0) return { kind: 'none' }
  const base = before ?? EMPTY_ITEM_RULES
  if (named.every(([field, value]) => sameRule(field, base[field], value))) return { kind: 'none' }
  const { values, cleared } = mergeItemRules(before, patch)
  const problems = itemRuleProblems(values, itemKind)
  const first = problems.find((issue) => named.some(([field]) => issue.path === `body/${field}`)) ?? problems[0]
  if (first) {
    const field = first.path.replace(/^body\//, '') as keyof ItemRuleValues
    return { kind: 'refused', field, words: ruleIssueWords(field, values, itemKind) }
  }
  return { kind: 'write', patch: Object.fromEntries(named) as ItemRulePatch, values, cleared }
}

/** A factory-domain refusal of one rule in our words (the rule the field broke, said again from the values). */
export function ruleIssueWords(field: keyof ItemRuleValues, values: ItemRuleValues, itemKind: string): RuleWords {
  switch (field) {
    case 'fixedLotQty':
      return values.lotSizing === 'FIXED' && values.fixedLotQty === null ? { key: 'items.problem.fixedNeeded' } : values.lotSizing !== 'FIXED' ? { key: 'items.problem.fixedOnly' } : { key: 'items.problem.fixedQty' }
    case 'lotPeriodDays':
      return values.lotSizing === 'PERIOD' && values.lotPeriodDays === null ? { key: 'items.problem.periodNeeded' } : values.lotSizing !== 'PERIOD' ? { key: 'items.problem.periodOnly' } : { key: 'items.problem.periodDays', params: { min: ITEM_RULE_LIMITS.periodDays.min, max: ITEM_RULE_LIMITS.periodDays.max } }
    case 'planLevel':
      return (PLAN_LEVEL_ITEM_KINDS as readonly string[]).includes(itemKind) ? { key: 'items.problem.planLevel' } : { key: 'items.held.material' }
    case 'scrapPct':
      return { key: 'items.problem.scrap' }
    case 'yieldPct':
      return { key: 'items.problem.yield' }
    case 'delayDays':
      return { key: 'items.problem.delay', params: { min: ITEM_RULE_LIMITS.delayDays.min, max: ITEM_RULE_LIMITS.delayDays.max } }
    default:
      return { key: 'items.problem.lotSizing' }
  }
}

const typed = (raw: unknown): string => String(raw ?? '').trim().replace(/\s/g, '').replace(',', '.')

/** A typed rule cell: '' clears it; days whole numbers; percents with at most two decimals (the domain checks the range). */
export function parseRule(field: RuleNumberField, raw: unknown): { value: number | string | null } | { problem: RuleWords } {
  const text = typed(raw)
  if (text === '') return { value: null }
  if (field === 'delayDays') return /^\d{1,4}$/.test(text) ? { value: Number(text) } : { problem: { key: 'items.problem.delay', params: { min: ITEM_RULE_LIMITS.delayDays.min, max: ITEM_RULE_LIMITS.delayDays.max } } }
  return /^\d{1,3}(\.\d{1,2})?$/.test(text) ? { value: text } : { problem: { key: field === 'scrapPct' ? 'items.problem.scrap' : 'items.problem.yield' } }
}

/** The lot-sizing dialog's patch as typed: the method with FIXED's lot or PERIOD's days (the other method's number cleared by the domain). */
export function lotPatch(lotSizing: LotSizing, fixed: string, period: string): { patch: ItemRulePatch } | { field: 'fixedLotQty' | 'lotPeriodDays'; words: RuleWords } {
  if (lotSizing === 'FIXED') {
    const text = typed(fixed)
    if (!/^\d+(\.\d{1,4})?$/.test(text) || Number(text) <= 0) return { field: 'fixedLotQty', words: { key: text === '' ? 'items.problem.fixedNeeded' : 'items.problem.fixedQty' } }
    return { patch: { lotSizing, fixedLotQty: text } }
  }
  if (lotSizing === 'PERIOD') {
    const text = typed(period)
    const { min, max } = ITEM_RULE_LIMITS.periodDays
    if (!/^\d{1,3}$/.test(text) || Number(text) < min || Number(text) > max) return { field: 'lotPeriodDays', words: text === '' ? { key: 'items.problem.periodNeeded' } : { key: 'items.problem.periodDays', params: { min, max } } }
    return { patch: { lotSizing, lotPeriodDays: Number(text) } }
  }
  return { patch: { lotSizing } }
}

/** Who keeps what: item parameters (planning.items.manage); a plan level also planning.strategy.manage (B-W2b-318). */
export interface RuleCan {
  manageItems: boolean
  strategy: boolean
}

/** Why the plan-level cell is held for this row and person (a key), or null. */
export function planLevelHeld(itemKind: string, can: RuleCan): string | null {
  if (!(PLAN_LEVEL_ITEM_KINDS as readonly string[]).includes(itemKind)) return 'items.held.material'
  if (!can.manageItems) return 'items.held.items'
  if (!can.strategy) return 'items.held.strategy'
  return null
}

/** Why a rule cell (lot sizing, scrap, yield, delay) is held, or null. */
export const ruleHeld = (can: RuleCan): string | null => (can.manageItems ? null : 'items.held.items')

/** "105" from "105.0000"; "2.5" from "2.50". */
export const plain = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value)

/** The lot-sizing cell's words: the method, with FIXED's lot or PERIOD's days. */
export function lotWords(values: ItemRuleValues | null, unit: string): RuleWords {
  if (!values || values.lotSizing === 'LOT_FOR_LOT') return { key: 'items.lot.LOT_FOR_LOT' }
  if (values.lotSizing === 'FIXED' && values.fixedLotQty !== null) return { key: 'items.lotCell.FIXED', params: { quantity: plain(values.fixedLotQty), unit } }
  if (values.lotSizing === 'PERIOD' && values.lotPeriodDays !== null) return { key: 'items.lotCell.PERIOD', params: { count: values.lotPeriodDays } }
  return { key: `items.lot.${values.lotSizing}` }
}

/** What the rules do, in our words (one sentence each; none when a rule is the default). Never the API's English `rules`. */
export function ruleWords(values: ItemRuleValues | null, facts: { readonly method: string; readonly itemKind: string; readonly unit: string; readonly minOrderQty: string | null; readonly orderMultiple: string | null; readonly maxOrderQty: string | null }): RuleWords[] {
  if (!values) return []
  const out: RuleWords[] = []
  const finished = facts.itemKind === 'FINISHED'
  if (values.lotSizing !== 'LOT_FOR_LOT') {
    if (finished) out.push({ key: 'items.words.lotFinished' })
    else if (values.lotSizing === 'FIXED' && values.fixedLotQty !== null) out.push({ key: 'items.words.FIXED', params: { quantity: plain(values.fixedLotQty), unit: facts.unit } })
    else if (values.lotSizing === 'PERIOD' && values.lotPeriodDays !== null) out.push({ key: 'items.words.PERIOD', params: { count: values.lotPeriodDays } })
    else if (values.lotSizing === 'MIN_MAX') {
      const limits = [facts.minOrderQty, facts.orderMultiple, facts.maxOrderQty].some((value) => value !== null)
      out.push(limits ? { key: 'items.words.MIN_MAX', params: { min: facts.minOrderQty ? plain(facts.minOrderQty) : '—', step: facts.orderMultiple ? plain(facts.orderMultiple) : '—', max: facts.maxOrderQty ? plain(facts.maxOrderQty) : '—', unit: facts.unit } } : { key: 'items.words.MIN_MAX_none' })
    }
    if (facts.method !== 'ORDERS' && !finished) out.push({ key: 'items.words.onlyOrders' })
  }
  if (values.planLevel !== null) out.push({ key: facts.itemKind === 'COMPONENT' ? 'items.words.levelComponent' : `items.words.level.${values.planLevel}` })
  const factor = scrapYieldFactor(values.scrapPct, values.yieldPct)
  if (factor !== null) out.push({ key: finished ? 'items.words.scrapYieldFinished' : 'items.words.scrapYield', params: { factor: plain(factor.toDecimalPlaces(4).toFixed(4)) } })
  if (values.delayDays !== null && values.delayDays > 0) out.push({ key: 'items.words.delay', params: { count: values.delayDays } })
  return out
}

/** "Cleared: the fixed lot" after a lot-sizing switch (none: null). */
export function clearedRuleWords(cleared: readonly string[]): RuleWords | null {
  const named = cleared.filter((field) => field === 'fixedLotQty' || field === 'lotPeriodDays')
  if (named.length === 0) return null
  return { key: 'items.cleared', params: { fields: named.map((field) => `items.field.${field}`).join('|') } }
}

// ---- the site's size-run rule (PLN-068; PATCH /planning/settings/:siteId {sizeRunRule, sizeGroups}) ------------------------------

export const SIZE_RUN_MAX = SIZE_RUN_LIMITS

/** The site's size run as read (an older answer: one grid). */
export const sizeRunOf = (settings: PlanningSettings | null): SizeRunValues =>
  settings ? { sizeRunRule: (settings.sizeRunRule ?? 'ONE_GRID') as SizeRunRule, sizeGroups: settings.sizeGroups ?? [] } : DEFAULT_SIZE_RUN

/** The groups as typed, one group per line, sizes split by commas or spaces ("44, 46, 48"). */
export const groupsOfText = (text: string): string[][] =>
  text
    .split('\n')
    .map((line) => line.split(/[,;\s]+/).map((code) => code.trim()).filter(Boolean))
    .filter((group) => group.length > 0)

export const textOfGroups = (groups: readonly (readonly string[])[]): string => groups.map((group) => group.join(', ')).join('\n')

/** The size-run dialog: what it sends, or the first problem in our words (factory-domain's sizeRunProblems decides). */
export function sizeRunPlan(current: SizeRunValues, rule: SizeRunRule, text: string): { kind: 'none' } | { kind: 'refused'; words: RuleWords } | { kind: 'write'; body: { sizeRunRule: SizeRunRule; sizeGroups: string[][] } } {
  const groups = rule === 'ONE_GRID' ? [] : groupsOfText(text)
  const next = mergeSizeRun(current, { sizeRunRule: rule, sizeGroups: groups })
  const same = next.sizeRunRule === current.sizeRunRule && JSON.stringify(next.sizeGroups) === JSON.stringify(current.sizeGroups)
  if (same) return { kind: 'none' }
  const problems = sizeRunProblems(next)
  if (problems.length > 0) {
    const issue = problems[0]!
    const seen = new Set<string>()
    const twice = next.sizeGroups.flat().find((code) => (seen.has(code) ? true : (seen.add(code), false)))
    if (twice) return { kind: 'refused', words: { key: 'items.sizeRun.problem.twice', params: { size: twice } } }
    if (issue.path.endsWith('/sizeGroups')) return { kind: 'refused', words: { key: 'items.sizeRun.problem.groups', params: { min: SIZE_RUN_LIMITS.groups.min, max: SIZE_RUN_LIMITS.groups.max } } }
    return { kind: 'refused', words: { key: 'items.sizeRun.problem.codes', params: { min: SIZE_RUN_LIMITS.codes.min, max: SIZE_RUN_LIMITS.codes.max, code: SIZE_RUN_LIMITS.code } } }
  }
  return { kind: 'write', body: { sizeRunRule: next.sizeRunRule, sizeGroups: next.sizeGroups.map((group) => [...group]) } }
}
