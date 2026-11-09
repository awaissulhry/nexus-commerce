import type { Issue } from '../../core/errors'
import { numberText } from '../../inventory/rolls/rolls'
import { Dec, HUNDRED, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'
import { ITEM_KINDS, type ItemKind } from '../materials/rules'
import type { RuleSource } from '../lifecycle/rules'

/**
 * The product settings (B-W2b-221; design products.settings, SCR-251; factory-db ProductSettings), pure: the consumption
 * tolerance (PRD-105, "Per BOM or line: actual use must match, may differ, or may differ with a warning above a percentage";
 * "Hides vary; over-use should warn, not stop the line"). The edit rules per lifecycle state are ../lifecycle/rules.
 *
 *   MATCH        what was really used must match the estimate: a different figure is refused until someone explains it
 *                (a note with the confirmation)
 *   MAY_DIFFER   the figure typed is kept (W1 and B-W2b-116's behaviour, and the default)
 *   WARN_ABOVE   it may differ; a difference above the percent (either way: more or less than the estimate) is a warning
 *
 * Which applies to a material: the company's row per material kind, then its rule, then the tenant-wide row per kind, then
 * its rule, then MAY_DIFFER (`toleranceFor`). The cut consumption confirmation (B-W2b-116's fabric used at cut finish) asks
 * it for the cut order's material (apps/factory-api modules/production/lays/consumption-tolerance.ts). No money: lengths.
 */

export const CONSUMPTION_TOLERANCES = ['MATCH', 'MAY_DIFFER', 'WARN_ABOVE'] as const
export type ConsumptionTolerance = (typeof CONSUMPTION_TOLERANCES)[number]

/** One rule: the percent exactly with WARN_ABOVE (a decimal string above 0 and at most 100). */
export interface ToleranceRule {
  readonly rule: ConsumptionTolerance
  readonly percent: string | null
}

/** A ProductSettings row as far as the tolerance goes. */
export interface ToleranceRow {
  readonly consumptionTolerance: ConsumptionTolerance | null
  /** A decimal string, or null. */
  readonly consumptionTolerancePct: string | null
  /** { "LEATHER": { "rule": "WARN_ABOVE", "percent": "5" } } as stored (checked by the database). */
  readonly consumptionToleranceByKind: unknown
}

export const DEFAULT_TOLERANCE: ToleranceRule = Object.freeze({ rule: 'MAY_DIFFER', percent: null })

export const TOLERANCE_WORDS: Readonly<Record<ConsumptionTolerance, string>> = Object.freeze({
  MATCH: 'must match',
  MAY_DIFFER: 'may differ',
  WARN_ABOVE: 'warns above a percent',
})

const PERCENT = /^\d{1,3}(\.\d{1,4})?$/

/** A percent as typed: a decimal string above 0 and at most 100, at most 4 decimals, or null. */
export function percentOf(value: unknown): Decimal | null {
  if (typeof value !== 'string' || !PERCENT.test(value.trim())) return null
  const parsed = parseDecimal(value.trim())
  return parsed !== null && parsed.greaterThan(ZERO) && parsed.lessThanOrEqualTo(HUNDRED) ? parsed : null
}

/** A row's rule per kind, when its shape is right (the database checks it on write); anything else is not set. */
function byKindOf(row: ToleranceRow | null, kind: ItemKind): ToleranceRule | null {
  const map = row?.consumptionToleranceByKind
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return null
  const entry = (map as Record<string, unknown>)[kind]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const { rule, percent } = entry as { rule?: unknown; percent?: unknown }
  if (!(CONSUMPTION_TOLERANCES as readonly unknown[]).includes(rule)) return null
  if (rule === 'WARN_ABOVE') return percentOf(percent) === null ? null : { rule, percent: String(percent).trim() }
  return { rule: rule as ConsumptionTolerance, percent: null }
}

function ownRule(row: ToleranceRow | null): ToleranceRule | null {
  if (!row?.consumptionTolerance) return null
  if (row.consumptionTolerance === 'WARN_ABOVE') return row.consumptionTolerancePct === null ? null : { rule: 'WARN_ABOVE', percent: new Dec(row.consumptionTolerancePct).toString() }
  return { rule: row.consumptionTolerance, percent: null }
}

/**
 * The tolerance of a material kind: the company's row per kind, its rule, the tenant-wide row per kind, its rule, MAY_DIFFER.
 * `kind` null (no material known): the rules only.
 */
export function toleranceFor(company: ToleranceRow | null, tenant: ToleranceRow | null, kind: ItemKind | null): ToleranceRule & { source: RuleSource; byKind: boolean } {
  const steps: [ToleranceRule | null, RuleSource, boolean][] = [
    [kind === null ? null : byKindOf(company, kind), 'COMPANY', true],
    [ownRule(company), 'COMPANY', false],
    [kind === null ? null : byKindOf(tenant, kind), 'TENANT', true],
    [ownRule(tenant), 'TENANT', false],
  ]
  for (const [rule, source, byKind] of steps) if (rule !== null) return { ...rule, source, byKind }
  return { ...DEFAULT_TOLERANCE, source: 'DEFAULT', byKind: false }
}

/** Every kind's tolerance in force (the "Per material kind" part of psettings.tolerance). */
export function toleranceTable(company: ToleranceRow | null, tenant: ToleranceRow | null): { kind: ItemKind; rule: ConsumptionTolerance; percent: string | null; source: RuleSource; byKind: boolean }[] {
  return ITEM_KINDS.map((kind) => ({ kind, ...toleranceFor(company, tenant, kind) }))
}

// ---- the check at the confirmation ---------------------------------------------------------------------------------------

export const CONSUMPTION_REFUSALS = ['CONSUMPTION_MUST_MATCH'] as const
export type ConsumptionRefusalCode = (typeof CONSUMPTION_REFUSALS)[number]
export const CONSUMPTION_WARNINGS = ['CONSUMPTION_ABOVE_TOLERANCE'] as const
export type ConsumptionWarningCode = (typeof CONSUMPTION_WARNINGS)[number]

export type ConsumptionCheck =
  | { readonly outcome: 'OK' }
  | { readonly outcome: 'REFUSED'; readonly code: ConsumptionRefusalCode; readonly message: string }
  | { readonly outcome: 'WARNING'; readonly code: ConsumptionWarningCode; readonly message: string }

/** What the check reads: lengths in one unit (B-W2b-116: metres), the note given with the confirmation. */
export interface ConsumptionFacts {
  readonly estimated: Decimal
  readonly confirmed: Decimal
  /** The note the confirmation carries (trimmed; empty = none). */
  readonly note: string | null
  /** "m", for the words. */
  readonly unit: string
  /** What the material is called in the words ("fabric", "leather"). */
  readonly what: string
}

/** The difference as a percent of the estimate, to one decimal (null when the estimate is 0). */
export function differencePercent(estimated: Decimal, confirmed: Decimal): Decimal | null {
  if (estimated.isZero()) return null
  return confirmed.minus(estimated).times(100).dividedBy(estimated)
}

const metres = (value: Decimal, unit: string): string => `${numberText(value.toDecimalPlaces(4, Dec.ROUND_HALF_UP), 'en')} ${unit}`

/**
 * The confirmation against the rule. MATCH: equal to the estimate, or a note that explains the difference; WARN_ABOVE: a
 * warning when the difference (either way) is above the percent; MAY_DIFFER: always OK. The words name both figures.
 */
export function consumptionCheck(rule: ToleranceRule, facts: ConsumptionFacts): ConsumptionCheck {
  const { estimated, confirmed, unit, what } = facts
  const difference = confirmed.minus(estimated)
  if (difference.isZero() || rule.rule === 'MAY_DIFFER') return { outcome: 'OK' }
  const percent = differencePercent(estimated, confirmed)
  const share = percent === null ? '' : ` (${percent.greaterThan(0) ? '+' : '−'}${numberText(percent.abs().toDecimalPlaces(1, Dec.ROUND_HALF_UP), 'en')}%)`
  const moreOrLess = `${metres(difference.abs(), unit)} ${difference.greaterThan(0) ? 'more' : 'less'} than the estimate of ${metres(estimated, unit)}${share}`
  if (rule.rule === 'MATCH') {
    if (facts.note?.trim()) return { outcome: 'OK' }
    return {
      outcome: 'REFUSED',
      code: 'CONSUMPTION_MUST_MATCH',
      message: `The ${what} used must match the estimate: ${metres(confirmed, unit)} is ${moreOrLess}. Say why in a note, or confirm ${metres(estimated, unit)}.`,
    }
  }
  const limit = percentOf(rule.percent)
  if (limit === null || percent === null || percent.abs().lessThanOrEqualTo(limit)) return { outcome: 'OK' }
  return {
    outcome: 'WARNING',
    code: 'CONSUMPTION_ABOVE_TOLERANCE',
    message: `${metres(confirmed, unit)} of ${what} is ${moreOrLess}: above the ${numberText(limit, 'en')}% tolerance.`,
  }
}

// ---- a change of the settings --------------------------------------------------------------------------------------------

/** A per-kind entry as typed. */
export interface KindToleranceInput {
  readonly rule: ConsumptionTolerance
  readonly percent?: string | null | undefined
}

/**
 * The tolerance part of a change, checked as the database will (ProductSettings_check), paths under `at`: the percent
 * exactly with WARN_ABOVE, above 0 and at most 100; per kind, ItemKind names only.
 */
export function toleranceProblems(
  change: { readonly rule: ConsumptionTolerance | null; readonly percent: string | null; readonly byKind: Readonly<Record<string, KindToleranceInput>> | null },
  at = 'body',
): Issue[] {
  const issues: Issue[] = []
  if (change.rule === 'WARN_ABOVE' && percentOf(change.percent) === null) issues.push({ path: `${at}/consumptionTolerancePct`, message: 'Warn above which percent? A number above 0 and at most 100.' })
  if (change.rule !== 'WARN_ABOVE' && change.percent !== null) issues.push({ path: `${at}/consumptionTolerancePct`, message: 'A percent goes only with "warn above a percent".' })
  for (const [kind, entry] of Object.entries(change.byKind ?? {})) {
    const path = `${at}/consumptionToleranceByKind/${kind}`
    if (!(ITEM_KINDS as readonly string[]).includes(kind)) {
      issues.push({ path, message: `${kind} is not a material kind (${ITEM_KINDS.join(', ')}).` })
      continue
    }
    const percent = entry.percent ?? null
    if (entry.rule === 'WARN_ABOVE' && percentOf(percent) === null) issues.push({ path: `${path}/percent`, message: 'Warn above which percent? A number above 0 and at most 100.' })
    if (entry.rule !== 'WARN_ABOVE' && percent !== null) issues.push({ path: `${path}/percent`, message: 'A percent goes only with "warn above a percent".' })
  }
  return issues
}

/** The per-kind map as stored: kinds in ITEM_KINDS order, the percent normalised ("5.0" → "5"); empty → null. */
export function storedByKind(byKind: Readonly<Record<string, KindToleranceInput>> | null): Record<string, { rule: ConsumptionTolerance; percent?: string }> | null {
  if (byKind === null) return null
  const entries = ITEM_KINDS.filter((kind) => byKind[kind] !== undefined).map((kind) => {
    const entry = byKind[kind]!
    const percent = entry.rule === 'WARN_ABOVE' ? percentOf(entry.percent)! : null
    return [kind, percent === null ? { rule: entry.rule } : { rule: entry.rule, percent: percent.toString() }] as const
  })
  return entries.length === 0 ? null : Object.fromEntries(entries)
}
