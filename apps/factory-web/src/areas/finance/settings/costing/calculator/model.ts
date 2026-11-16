import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { CalcView, OverheadRuleView, PrefillView } from './api'

/**
 * Finance › Settings › Costing › the cost-per-minute calculator (B-W2b-430; design finance.settings sec:costing "Cost per
 * minute and overhead (W2b)", "Cost-per-minute calculator (W2b): labour ÷ available minutes + overhead"; FIN-005), pure:
 * who may read (costing.view) and write (costing.rates.manage, with the cost grain: the payroll total is a cost), the period
 * as whole months (at most 12), the figures typed, the cost per minute they make (the API's rule: direct ÷ minutes +
 * indirect + overhead, one rounding to 6 places), why each step waits, the refusals in words. Never a headcount or a figure
 * about one person: a department's payroll total over its planned seats' minutes (a department of one seat is refused).
 * Words: `cost-sheets` (`cpm.*`).
 */

export const CPM_NS = 'cost-sheets'

/** The departments a calculation is for (an outside workshop has no payroll of ours). */
export const CPM_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING'] as const
export type CpmKind = (typeof CPM_KINDS)[number]

export interface CpmAbilities {
  view: boolean
  manage: boolean
  cost: boolean
}

export function cpmAbilitiesOf(permissions: readonly string[]): CpmAbilities {
  const held = new Set(permissions)
  return { view: held.has('costing.view'), manage: held.has('costing.rates.manage'), cost: held.has('money.cost') }
}

/** What the New calculation dialog holds while the person types. */
export interface CalcDraft {
  readonly workCentreKind: CpmKind
  /** '' = the whole department. */
  readonly workCentreId: string
  /** YYYY-MM. */
  readonly fromMonth: string
  readonly toMonth: string
  readonly directLabourCost: string
  readonly availableMinutes: string
  readonly indirectPerMinute: string
  readonly overheadPerMinute: string
  readonly note: string
}

/** The month before `today` (YYYY-MM-DD): a calculation is usually made on last month's payroll. */
export function lastMonth(today: string): string {
  const [year, month] = today.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 2, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function calcDraftOf(today: string, given?: Partial<CalcDraft>): CalcDraft {
  const month = lastMonth(today)
  return { workCentreKind: 'SEWING', workCentreId: '', fromMonth: month, toMonth: month, directLabourCost: '', availableMinutes: '', indirectPerMinute: '', overheadPerMinute: '', note: '', ...given }
}

/** The first day of a month (YYYY-MM → YYYY-MM-01) and its last day. */
export const monthStart = (month: string): string => `${month}-01`
export function monthLast(month: string): string {
  const [year, number] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year!, number!, 0)).getUTCDate()
  return `${month}-${String(last).padStart(2, '0')}`
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** The months a calculation may cover: this one and the 23 before, newest first (YYYY-MM). */
export function monthOptions(today: string): string[] {
  const [year, month] = today.split('-').map(Number)
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1 - index, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/** A month in the person's language ("ottobre 2026", "October 2026"). */
export function monthName(month: string, locale: 'it' | 'en'): string {
  const [year, number] = month.split('-').map(Number)
  if (!year || !number) return month
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 15)))
}

/** Months from → to inclusive, or null when either is not a month or `to` is before `from`. */
export function monthsBetween(from: string, to: string): number | null {
  if (!MONTH.test(from) || !MONTH.test(to)) return null
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  const months = (ty! - fy!) * 12 + (tm! - fm!) + 1
  return months >= 1 ? months : null
}

/** A typed figure (0 or more, at most 12 digits and 6 decimals) as the API takes it, or null; '' = not typed. */
export function typedFigure(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  return /^\d{1,12}(\.\d{1,6})?$/.test(value) ? value : null
}

/** Typed minutes (more than 0, at most 4 decimals), or null. */
export function typedMinutes(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  return /^\d{1,14}(\.\d{1,4})?$/.test(value) && Number(value) > 0 ? value : null
}

export type CalcField = 'period' | 'directLabourCost' | 'availableMinutes' | 'indirectPerMinute' | 'overheadPerMinute' | 'note'

/** The dialog's problems by field (message keys). */
export function calcProblems(draft: CalcDraft): Partial<Record<CalcField, string>> {
  const problems: Partial<Record<CalcField, string>> = {}
  const months = monthsBetween(draft.fromMonth, draft.toMonth)
  if (months === null) problems.period = 'cpm.problem.period'
  else if (months > 12) problems.period = 'cpm.problem.periodLong'
  if (draft.directLabourCost.trim() === '') problems.directLabourCost = 'cpm.problem.directEmpty'
  else if (typedFigure(draft.directLabourCost) === null) problems.directLabourCost = 'cpm.problem.figure'
  if (draft.availableMinutes.trim() === '') problems.availableMinutes = 'cpm.problem.minutesEmpty'
  else if (typedMinutes(draft.availableMinutes) === null) problems.availableMinutes = 'cpm.problem.minutes'
  if (draft.indirectPerMinute.trim() !== '' && typedFigure(draft.indirectPerMinute) === null) problems.indirectPerMinute = 'cpm.problem.figure'
  if (draft.overheadPerMinute.trim() !== '' && typedFigure(draft.overheadPerMinute) === null) problems.overheadPerMinute = 'cpm.problem.figure'
  if (draft.note.trim().length > 1000) problems.note = 'cpm.problem.note'
  return problems
}

/** The cost per minute the figures make (the API's rule, 6 places half up), or null while a figure is missing or wrong. */
export function costPerMinute(draft: Pick<CalcDraft, 'directLabourCost' | 'availableMinutes' | 'indirectPerMinute' | 'overheadPerMinute'>): string | null {
  const direct = typedFigure(draft.directLabourCost)
  const minutes = typedMinutes(draft.availableMinutes)
  const indirect = draft.indirectPerMinute.trim() === '' ? '0' : typedFigure(draft.indirectPerMinute)
  const overhead = draft.overheadPerMinute.trim() === '' ? '0' : typedFigure(draft.overheadPerMinute)
  if (direct === null || minutes === null || indirect === null || overhead === null) return null
  const value = Number(direct) / Number(minutes) + Number(indirect) + Number(overhead)
  return (Math.round(value * 1e6) / 1e6).toFixed(6)
}

/** Overhead counted twice: the rate carries overhead a minute while per-minute rules add theirs on the cost sheet. */
export function overheadTwice(draft: Pick<CalcDraft, 'overheadPerMinute'>, prefilled: Pick<PrefillView, 'overheadPerMinuteFromRules'> | null): boolean {
  const typed = typedFigure(draft.overheadPerMinute)
  return !!prefilled && typed !== null && Number(typed) > 0 && Number(prefilled.overheadPerMinuteFromRules ?? '0') > 0
}

/** The body of POST /costing/cost-per-minute. */
export function calcBody(draft: CalcDraft, companyId: string, prefilled: PrefillView | null) {
  return {
    companyId,
    workCentreKind: draft.workCentreKind,
    ...(draft.workCentreId ? { workCentreId: draft.workCentreId } : {}),
    periodStart: monthStart(draft.fromMonth),
    periodEnd: monthLast(draft.toMonth),
    directLabourCost: typedFigure(draft.directLabourCost) ?? draft.directLabourCost,
    availableMinutes: typedMinutes(draft.availableMinutes) ?? draft.availableMinutes,
    ...(draft.indirectPerMinute.trim() ? { indirectPerMinute: typedFigure(draft.indirectPerMinute) ?? draft.indirectPerMinute } : {}),
    ...(draft.overheadPerMinute.trim() ? { overheadPerMinute: typedFigure(draft.overheadPerMinute) ?? draft.overheadPerMinute } : {}),
    ...(prefilled && prefilled.workCentreKind === draft.workCentreKind && prefilled.periodStart === monthStart(draft.fromMonth) && prefilled.periodEnd === monthLast(draft.toMonth) ? { minutesBasis: prefilled.minutesBasis } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

/** Why "New calculation" waits, or null. */
export function newHeld(can: CpmAbilities, busy: boolean): string | null {
  if (!can.manage) return 'cpm.held.noManage'
  if (!can.cost) return 'cpm.held.noGrain'
  if (busy) return 'cpm.held.busy'
  return null
}

/** Why Apply or Delete waits for a calculation, or null: not applied yet, by a person who keeps the rates. */
export function rowHeld(calc: Pick<CalcView, 'labourRateId'>, can: CpmAbilities, busy: boolean): string | null {
  if (!can.manage) return 'cpm.held.noManage'
  if (calc.labourRateId) return 'cpm.held.applied'
  if (busy) return 'cpm.held.busy'
  return null
}

/** Why "Apply" in its dialog waits: a first day today or later (a past day would price work already costed), an efficiency 1 … 999. */
export function applyProblems(input: { validFrom: string; efficiency: string }, today: string): { validFrom?: string; efficiency?: string } {
  const problems: { validFrom?: string; efficiency?: string } = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) problems.validFrom = 'cpm.problem.day'
  else if (input.validFrom < today) problems.validFrom = 'cpmRefusal.PAST_DAY'
  const efficiency = input.efficiency.trim().replace(',', '.')
  if (efficiency !== '' && (!/^\d{1,3}(\.\d{1,4})?$/.test(efficiency) || Number(efficiency) <= 0)) problems.efficiency = 'cpm.problem.efficiency'
  return problems
}

export const CPM_REFUSALS = ['APPLIED', 'ANOTHER_APPLIED', 'PAST_DAY', 'CURRENCY', 'ONE_SEAT', 'NOT_OF_KIND', 'TOO_BIG', 'DATABASE'] as const

/** A refused write in words: its refusal (`cpmRefusal.<CODE>`), else the kind. */
export function cpmProblem(error: unknown): string {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
      if (match && (CPM_REFUSALS as readonly string[]).includes(match[1]!)) return `cpmRefusal.${match[1]}`
    }
    if (error.kind === 'conflict') return 'cpm.problem.moved'
    if (error.kind === 'forbidden') return 'cpm.problem.forbidden'
    if (error.kind === 'invalid') return 'cpm.problem.invalid'
    if (error.kind === 'not_found') return 'cpm.problem.notFound'
  }
  return 'cpm.problem.unavailable'
}

/** A failed read in words. */
export function cpmReadProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'cpm.problem.readForbidden'
  return 'cpm.problem.read'
}

/** A live change that moves the calculator's lists. */
export const cpmTouched = (change: { type: string }): boolean => change.type === 'cost_per_minute.changed' || change.type === 'overhead_rule.changed' || change.type === 'labour_rate.created'

// ---- B-W2b-GB02 (G054; B-W2b-430 gap 3 "overhead rules are read only on screen"): the overhead rules kept on screen -------

/** What an overhead rule absorbs on (factory-domain costing/overhead-rules OVERHEAD_BASES). */
export const OHR_BASES = ['PERCENT_OF_LABOUR', 'PER_MINUTE', 'PER_UNIT', 'PER_MACHINE_HOUR'] as const
export type OhrBasis = (typeof OHR_BASES)[number]
/** The kinds of work centre a rule may be for (the API's WORK_CENTRE_KINDS); '' = every department. */
export const OHR_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const

/** What the New rule dialog holds. A rule is per whole months: from the first of a month, open-ended or to the end of one. */
export interface RuleDraft {
  /** This company's own rule, or every company's (a role over every company). */
  readonly scope: 'company' | 'every'
  readonly basis: OhrBasis
  /** '' = every department. */
  readonly workCentreKind: string
  /** A percent of labour, or an amount a minute, a garment or a machine hour. */
  readonly value: string
  readonly currency: string
  /** YYYY-MM. */
  readonly fromMonth: string
  /** YYYY-MM, '' = open-ended. */
  readonly toMonth: string
  readonly note: string
  /** End the active rule of the same company, basis and department that runs into this one, the day before it starts. */
  readonly endPrevious: boolean
}

/** This month (YYYY-MM) of `today`. */
const thisMonth = (today: string): string => today.slice(0, 7)

export function ruleDraftOf(today: string, currency: string | null, given?: Partial<RuleDraft>): RuleDraft {
  return { scope: 'company', basis: 'PERCENT_OF_LABOUR', workCentreKind: '', value: '', currency: currency ?? 'EUR', fromMonth: thisMonth(today), toMonth: '', note: '', endPrevious: true, ...given }
}

/** An amount basis has a currency; a percent of labour none. */
export const isAmountBasis = (basis: OhrBasis): boolean => basis !== 'PERCENT_OF_LABOUR'

export type RuleField = 'value' | 'currency' | 'period' | 'note'

/** A typed rule value: a figure above 0 (12 digits, 6 decimals), a percent at most 1000. */
function ruleValue(text: string, basis: OhrBasis): string | null {
  const value = typedFigure(text)
  if (value === null || !(Number(value) > 0)) return null
  if (!isAmountBasis(basis) && Number(value) > 1000) return null
  return value
}

/** The New rule dialog's problems by field (message keys). */
export function ruleProblems(draft: RuleDraft): Partial<Record<RuleField, string>> {
  const problems: Partial<Record<RuleField, string>> = {}
  if (draft.value.trim() === '') problems.value = 'ohrEdit.problem.valueEmpty'
  else if (ruleValue(draft.value, draft.basis) === null) problems.value = isAmountBasis(draft.basis) ? 'ohrEdit.problem.amount' : 'ohrEdit.problem.percent'
  if (isAmountBasis(draft.basis) && !/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())) problems.currency = 'ohrEdit.problem.currency'
  if (!MONTH.test(draft.fromMonth) || (draft.toMonth !== '' && monthsBetween(draft.fromMonth, draft.toMonth) === null)) problems.period = 'ohrEdit.problem.period'
  if (draft.note.trim().length > 1000) problems.note = 'cpm.problem.note'
  return problems
}

/** The body of POST /costing/overhead-rules. */
export function ruleBody(draft: RuleDraft, companyId: string) {
  return {
    companyId: draft.scope === 'company' ? companyId : null,
    basis: draft.basis,
    workCentreKind: draft.workCentreKind === '' ? null : draft.workCentreKind,
    value: ruleValue(draft.value, draft.basis) ?? draft.value,
    currency: isAmountBasis(draft.basis) ? draft.currency.trim().toUpperCase() : null,
    periodStart: monthStart(draft.fromMonth),
    periodEnd: draft.toMonth === '' ? null : monthLast(draft.toMonth),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(draft.endPrevious ? { endPrevious: true } : {}),
  }
}

/** What the Correct dialog holds for an active rule (company, basis, department and first month never change). */
export interface RuleEdit {
  readonly value: string
  readonly currency: string
  readonly toMonth: string
  readonly note: string
}

export const ruleEditOf = (rule: Pick<OverheadRuleView, 'value' | 'currency' | 'periodEnd' | 'note'>): RuleEdit => ({
  value: rule.value === undefined || rule.value === null ? '' : String(Number(rule.value)),
  currency: rule.currency ?? '',
  toMonth: rule.periodEnd ? rule.periodEnd.slice(0, 7) : '',
  note: rule.note ?? '',
})

export function ruleEditProblems(edit: RuleEdit, rule: Pick<OverheadRuleView, 'basis' | 'periodStart'>): Partial<Record<RuleField, string>> {
  const problems = ruleProblems({ scope: 'company', basis: rule.basis, workCentreKind: '', value: edit.value, currency: edit.currency, fromMonth: rule.periodStart.slice(0, 7), toMonth: edit.toMonth, note: edit.note, endPrevious: false })
  return problems
}

/** The body of PATCH /costing/overhead-rules/:id: only what changed, with the row's version; null when nothing changes. */
export function ruleEditBody(edit: RuleEdit, rule: Pick<OverheadRuleView, 'basis' | 'value' | 'currency' | 'periodEnd' | 'note' | 'version'>) {
  const before = ruleEditOf(rule)
  const body: Record<string, unknown> = { version: rule.version }
  const value = ruleValue(edit.value, rule.basis)
  if (value !== null && (rule.value === undefined || rule.value === null || Number(value) !== Number(rule.value))) body.value = value
  if (isAmountBasis(rule.basis) && edit.currency.trim().toUpperCase() !== before.currency) body.currency = edit.currency.trim().toUpperCase()
  if (edit.toMonth !== before.toMonth) body.periodEnd = edit.toMonth === '' ? null : monthLast(edit.toMonth)
  if (edit.note.trim() !== before.note) body.note = edit.note.trim() === '' ? null : edit.note.trim()
  return Object.keys(body).length === 1 ? null : body
}

/** Why "New rule" waits, or null (a value is a cost: the grain). */
export const ruleNewHeld = (can: CpmAbilities, busy: boolean): string | null => newHeld(can, busy)

/** Why Correct or Archive of a rule waits, or null: an active rule, by a person who keeps the rates (every company's: said by the API). */
export function ruleRowHeld(rule: Pick<OverheadRuleView, 'status'>, can: CpmAbilities, busy: boolean): string | null {
  if (!can.manage) return 'cpm.held.noManage'
  if (rule.status !== 'ACTIVE') return 'ohrEdit.held.archived'
  if (!can.cost) return 'cpm.held.noGrain'
  if (busy) return 'cpm.held.busy'
  return null
}

export const OHR_REFUSALS = ['OVERLAPS', 'START_TAKEN', 'ARCHIVED', 'NOTHING_CHANGES', 'DATABASE'] as const

/** A refused rule write in words: its refusal (`ohrRefusal.<CODE>`), else the kind (the calculator's words). */
export function ohrProblem(error: unknown): string {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
      if (match && (OHR_REFUSALS as readonly string[]).includes(match[1]!)) return `ohrRefusal.${match[1]}`
    }
  }
  return cpmProblem(error)
}
// ---- end B-W2b-GB02
