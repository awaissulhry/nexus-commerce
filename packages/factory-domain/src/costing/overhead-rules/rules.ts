import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, UNIT_PRICE } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { WorkCentreKind } from '../../product/routing/operations'
import { defineMachine } from '../../state/machine'
import { Dec, type Decimal } from '../../tax/decimal'
import { monthsProblems } from '../cost-per-minute/rules'

/**
 * Overhead absorption rules (B-W2b-419; FIN-007; design finance.settings › Costing; OverheadRule of B-W2b-378), pure. A rule
 * absorbs overhead on one basis — a percent of the labour cost, a cost per standard minute, per garment or per machine hour —
 * for one kind of work centre or all, per company (or every company) and period of whole months (open-ended, or to the last
 * day of a month). Rules of different bases add up; the rules of one key (company, basis, kind) never overlap in time (the
 * database holds it too). For a company and a kind on a day, each basis takes its most specific rule in force: the company's
 * own for that kind, then the company's for every kind, then every company's for that kind, then every company's for every
 * kind (a company's own row wins, A1 §2.1). While none is in force, the cost sheet keeps the costing settings' overhead
 * percent on material + labour (W1).
 *
 * UNVERIFIED (GATE-ACCOUNTANT): the bases and the rates wait for the accountant's word. A rule changes no posted cost: the cost
 * ledger's overhead entries keep the costing settings' percent (B-W2a-21); the rules price the cost sheet's estimate and the
 * cost-per-minute calculator's suggestion, and reach a posted cost only through what a person applies (a labour rate from
 * the calculator, a standard cost frozen from a cost sheet).
 */

export const OVERHEAD_BASES = ['PERCENT_OF_LABOUR', 'PER_MINUTE', 'PER_UNIT', 'PER_MACHINE_HOUR'] as const
export type OverheadBasis = (typeof OVERHEAD_BASES)[number]

export const OVERHEAD_RULE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type OverheadRuleStatus = (typeof OVERHEAD_RULE_STATUSES)[number]

/** Archived is final: cost sheets that named the rule keep reading it; a new figure is a new rule. */
export const overheadRuleMachine = defineMachine({ name: 'overheadRule', states: OVERHEAD_RULE_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: [] } })

/** `overhead:<companyId | all>:<basis>:<kind | all>` (the database's key). */
export const overheadKey = (companyId: string | null, basis: OverheadBasis, kind: WorkCentreKind | null): string => `overhead:${companyId ?? 'all'}:${basis}:${kind ?? 'all'}`

/** The highest percent of labour (the database's). */
export const MAX_LABOUR_PCT = '1000'

/** The figure of a rule: a percent (no currency) or an amount with its currency. */
export interface RuleFigure {
  readonly basis: OverheadBasis
  readonly value: string
  readonly currency: string | null
}

/** What is wrong with a rule's figure (paths `body/value`, `body/currency`). */
export function figureProblems(rule: RuleFigure): Issue[] {
  const issues: Issue[] = []
  const plain = /^\d+(?:\.\d+)?$/.test(rule.value) && fitsDecimal(rule.value, UNIT_PRICE.precision, UNIT_PRICE.scale)
  if (rule.basis === 'PERCENT_OF_LABOUR') {
    if (!plain || !new Dec(rule.value).gt(0) || new Dec(rule.value).gt(MAX_LABOUR_PCT)) issues.push({ path: 'body/value', message: `Expected a percent above 0 and at most ${MAX_LABOUR_PCT}, with at most 6 decimals.` })
    if (rule.currency !== null) issues.push({ path: 'body/currency', message: 'A percent of labour has no currency.' })
    return issues
  }
  if (!plain || !new Dec(rule.value).gt(0)) issues.push({ path: 'body/value', message: 'Expected an amount above 0, with at most 12 digits and 6 decimals.' })
  if (rule.currency === null || !isCurrencyCode(rule.currency)) issues.push({ path: 'body/currency', message: 'An amount per minute, garment or machine hour has its ISO 4217 currency, such as EUR.' })
  return issues
}

/** What is wrong with a rule's period: whole months, open-ended or to the last day of a month. */
export const periodProblems = (periodStart: string, periodEnd: string | null): Issue[] => monthsProblems(periodStart, periodEnd, { open: true })

/** A rule as the rules below read it (decimals as strings, days as YYYY-MM-DD). */
export interface OverheadRuleFacts extends RuleFigure {
  readonly id: string
  readonly companyId: string | null
  readonly workCentreKind: WorkCentreKind | null
  readonly periodStart: BusinessDate
  readonly periodEnd: BusinessDate | null
  readonly status: OverheadRuleStatus
}

/** True when the rule is ACTIVE and its period holds the day. */
export const holds = (rule: Pick<OverheadRuleFacts, 'status' | 'periodStart' | 'periodEnd'>, on: BusinessDate): boolean =>
  rule.status === 'ACTIVE' && rule.periodStart <= on && (rule.periodEnd === null || on <= rule.periodEnd)

/** True when two periods share a day (null: open-ended). */
export const overlaps = (a: { readonly periodStart: BusinessDate; readonly periodEnd: BusinessDate | null }, b: { readonly periodStart: BusinessDate; readonly periodEnd: BusinessDate | null }): boolean =>
  (a.periodEnd === null || b.periodStart <= a.periodEnd) && (b.periodEnd === null || a.periodStart <= b.periodEnd)

/**
 * The rules in force for a company's work of one kind on a day, one per basis (in OVERHEAD_BASES order): the most specific
 * ACTIVE rule whose period holds the day — the company's own for the kind, the company's for every kind, every company's
 * for the kind, every company's for every kind. `kind` null: the rules for every kind only (a garment's own overhead).
 */
export function rulesInForce<Rule extends OverheadRuleFacts>(rules: readonly Rule[], companyId: string | null, kind: WorkCentreKind | null, on: BusinessDate): Rule[] {
  const ranks: { readonly companyId: string | null; readonly kind: WorkCentreKind | null }[] = [
    ...(companyId === null ? [] : [...(kind === null ? [] : [{ companyId, kind }]), { companyId, kind: null }]),
    ...(kind === null ? [] : [{ companyId: null, kind }]),
    { companyId: null, kind: null },
  ]
  const out: Rule[] = []
  for (const basis of OVERHEAD_BASES) {
    for (const rank of ranks) {
      const found = rules.find((rule) => rule.basis === basis && rule.companyId === rank.companyId && rule.workCentreKind === rank.kind && holds(rule, on))
      if (found) {
        out.push(found)
        break
      }
    }
  }
  return out
}

/** What the overhead is absorbed on: the labour cost, standard minutes, garments and machine hours (decimal strings). */
export interface AbsorptionFigures {
  readonly labourCost?: string | undefined
  readonly minutes?: string | undefined
  readonly units?: string | undefined
  readonly machineHours?: string | undefined
}

/** A figure an absorption line needs and was not given, or a rule in another currency. */
export const ABSORPTION_MISSING = ['LABOUR_COST', 'MINUTES', 'UNITS', 'MACHINE_HOURS', 'CURRENCY'] as const
export type AbsorptionMissing = (typeof ABSORPTION_MISSING)[number]

export const MISSING_WORDS: Readonly<Record<AbsorptionMissing, string>> = Object.freeze({
  LABOUR_COST: 'Give the labour cost: this rule is a percent of it.',
  MINUTES: 'Give the standard minutes: this rule is a cost per minute.',
  UNITS: 'Give the garments: this rule is a cost per garment.',
  MACHINE_HOURS: 'Give the machine hours: this rule is a cost per machine hour.',
  CURRENCY: "This rule is in another currency than the company's: it is listed as missing, never converted here.",
})

/**
 * One absorbed amount, shaped as a cost sheet line takes it (B-W2b-418): a percent line has quantity 1, the computed amount
 * as its unit cost and the percent; an amount line has the minutes, garments or machine hours as its quantity and the rule's
 * value as its unit cost. The amount is quantity × unit cost, rounded once, half up, to 6 places; null when a figure is
 * missing (never 0).
 */
export interface AbsorptionLine {
  readonly ruleId: string
  readonly basis: OverheadBasis
  readonly workCentreKind: WorkCentreKind | null
  readonly quantity: string | null
  readonly unitCost: string | null
  readonly pct: string | null
  readonly amount: string | null
  readonly missing: AbsorptionMissing | null
}

const six = (value: Decimal): string => value.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)

const NEEDS: Readonly<Record<Exclude<OverheadBasis, 'PERCENT_OF_LABOUR'>, { readonly figure: keyof AbsorptionFigures; readonly missing: AbsorptionMissing }>> = Object.freeze({
  PER_MINUTE: { figure: 'minutes', missing: 'MINUTES' },
  PER_UNIT: { figure: 'units', missing: 'UNITS' },
  PER_MACHINE_HOUR: { figure: 'machineHours', missing: 'MACHINE_HOURS' },
})

/**
 * The overhead the rules absorb on the figures given, in `currency`: one line per rule and their total (null while a line
 * misses a figure: the sheet says what is missing, never a total that leaves it out).
 */
export function absorb(rules: readonly OverheadRuleFacts[], figures: AbsorptionFigures, currency: string): { lines: AbsorptionLine[]; total: string | null } {
  const lines = rules.map((rule): AbsorptionLine => {
    const base = { ruleId: rule.id, basis: rule.basis, workCentreKind: rule.workCentreKind }
    if (rule.basis === 'PERCENT_OF_LABOUR') {
      if (figures.labourCost === undefined) return { ...base, quantity: null, unitCost: null, pct: rule.value, amount: null, missing: 'LABOUR_COST' }
      const amount = six(new Dec(figures.labourCost).times(rule.value).div(100))
      return { ...base, quantity: '1', unitCost: amount, pct: rule.value, amount, missing: null }
    }
    if (rule.currency !== currency) return { ...base, quantity: null, unitCost: rule.value, pct: null, amount: null, missing: 'CURRENCY' }
    const need = NEEDS[rule.basis]
    const quantity = figures[need.figure]
    if (quantity === undefined) return { ...base, quantity: null, unitCost: rule.value, pct: null, amount: null, missing: need.missing }
    return { ...base, quantity, unitCost: rule.value, pct: null, amount: six(new Dec(quantity).times(rule.value)), missing: null }
  })
  const total = lines.some((line) => line.amount === null) ? null : six(lines.reduce((sum, line) => sum.plus(line.amount!), new Dec(0)))
  return { lines, total }
}

/** The per-minute overhead the rules in force add for a kind: Σ PER_MINUTE values in `currency` (others left out). */
export function perMinuteOf(rules: readonly OverheadRuleFacts[], currency: string): string {
  return six(rules.filter((rule) => rule.basis === 'PER_MINUTE' && rule.currency === currency).reduce((sum, rule) => sum.plus(rule.value), new Dec(0)))
}

/** Why a rule write is refused, as the issue path `refusal/<code>`. */
export const OVERHEAD_REFUSALS = ['OVERLAPS', 'START_TAKEN', 'ARCHIVED', 'NOTHING_CHANGES', 'DATABASE'] as const
export type OverheadRefusal = (typeof OVERHEAD_REFUSALS)[number]

export const OVERHEAD_REFUSAL_WORDS: Readonly<Record<Exclude<OverheadRefusal, 'DATABASE'>, string>> = Object.freeze({
  OVERLAPS: 'Another active rule of the same company, basis and kind of work centre covers part of this period: end that one first (or send endPrevious when it starts earlier).',
  START_TAKEN: 'A rule of the same company, basis and kind of work centre starts that month already (perhaps archived): correct that one, or start the new one in another month.',
  ARCHIVED: 'This rule is archived: add a new rule instead.',
  NOTHING_CHANGES: 'Nothing changes: the rule is already so.',
})

/** The words of every rule while the accountant has not confirmed the bases and rates. */
export const OVERHEAD_UNVERIFIED =
  "UNVERIFIED: the overhead absorption bases and rates wait for the accountant's word (GATE-ACCOUNTANT). A rule changes no posted cost: the cost ledger keeps the costing settings' overhead percent; the rules price the cost sheet's estimate and reach a posted cost only through what a person applies (a labour rate from the cost-per-minute calculator, a standard cost frozen from a cost sheet)."

/** The words of the rules in force for a company and kind on a day: how many, and that they add up; none: W1's percent stays. */
export function inForceWords(count: number): string {
  if (count === 0) return "No overhead rule is in force here: the cost sheet keeps the costing settings' overhead percent on material + labour."
  return count === 1 ? 'One overhead rule is in force here.' : `${count} overhead rules are in force here, one per basis: they add up.`
}
