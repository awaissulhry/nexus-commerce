import {
  ALERT_LIMITS,
  alertRuleProblems,
  alertRuleSentence,
  EVENT_FACTS,
  QUALITY_ALERT_EVENTS,
  sortedDays,
  type AlertAudience,
  type AlertRuleDraft,
  type QualityAlertEvent,
} from '@nexus/factory-domain/quality/rules/alerts'
import { dutiesChanged, dutiesInForce, dutiesLoosenings, FOUR_EYES_CONDITIONS, type DutiesInForce, type DutiesRow, type FourEyesCondition, type Loosening } from '@nexus/factory-domain/quality/rules/duties'
import { benchUndoProblem, resultsChanged, resultsInForce, type ResultsInForce, type ResultsRow } from '@nexus/factory-domain/quality/rules/results'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AlertRule, AlertRuleBody, AlertRuleEdit, AlertRules, DutiesBody, ResultsBody, Rules } from './api'

/**
 * The rules of Quality › Settings › Quality rules (SCR-260; design quality.settings qs-sod, qs-alerts, qs-results,
 * qs-loosen), without React and without the API: the address (whose rules: this company or every company; the rule dialog),
 * each card's draft and what it sends (only the scope's own row), what is in force after it (factory-domain's own rules, so
 * the page says exactly what the API will decide), what a change loosens (the confirm and the fresh code), the alert rule's
 * draft with its problems at its fields, refusals in our words. Message keys are the `quality-rules` catalogue's.
 */

// ---- the address -----------------------------------------------------------------------------------------------------------

export type Scope = 'company' | 'all'

export interface Address {
  /** `?scope=all`: the rules of every company; else the company of the address. */
  readonly scope: Scope
  /** `?rule=<id>|new`: the alert rule dialog. */
  readonly rule: string | null
}

type Params = { get(name: string): string | null } | null | undefined

export function addressOf(params: Params): Address {
  return { scope: params?.get('scope') === 'all' ? 'all' : 'company', rule: params?.get('rule') || null }
}

export function queryOf(address: Address): string {
  const query = new URLSearchParams()
  if (address.scope === 'all') query.set('scope', 'all')
  if (address.rule) query.set('rule', address.rule)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- who may sign what ------------------------------------------------------------------------------------------------------

export interface DutiesDraft {
  /** null: follow every company's rule (a company) or the default (every company). */
  readonly releaseFourEyes: 'WHEN_REQUIRED' | 'ALWAYS' | null
  /** The scope's own conditions (a company adds to every company's). */
  readonly conditions: readonly FourEyesCondition[]
  /** The scope's own customers. */
  readonly customers: readonly string[]
  readonly placerMayRelease: boolean | null
}

const BOTH: readonly FourEyesCondition[] = Object.freeze([...FOUR_EYES_CONDITIONS].sort())

/** The scope's own row as saved (a scope with no row: what a new row would keep the rules in force with). */
export function ownDuties(rules: Rules): DutiesRow {
  const own = rules.duties.own
  if (own) return { releaseFourEyes: own.releaseFourEyes, fourEyesConditions: [...own.fourEyesConditions].sort(), secondPersonPartyIds: [...own.secondPersonPartyIds], placerMayRelease: own.placerMayRelease }
  // No row: a company follows every company in everything; every company reads the default (both conditions).
  return { releaseFourEyes: null, fourEyesConditions: rules.companyId === null ? [...BOTH] : [], secondPersonPartyIds: [], placerMayRelease: null }
}

export const dutiesDraftOf = (rules: Rules): DutiesDraft => {
  const own = ownDuties(rules)
  return { releaseFourEyes: own.releaseFourEyes, conditions: own.fourEyesConditions, customers: own.secondPersonPartyIds, placerMayRelease: own.placerMayRelease }
}

const rowOf = (draft: DutiesDraft): DutiesRow => ({ releaseFourEyes: draft.releaseFourEyes, fourEyesConditions: [...draft.conditions].sort(), secondPersonPartyIds: [...draft.customers], placerMayRelease: draft.placerMayRelease })

/** Every company's own row (its read), or null when it has none. */
const tenantRowOf = (tenant: Rules | null): DutiesRow | null => (tenant?.duties.own ? ownDuties(tenant) : null)

/** What is in force with a draft: a company with every company's row, or every company's row alone. */
export function dutiesPreview(rules: Rules, tenant: Rules | null, draft: DutiesDraft): DutiesInForce {
  return rules.companyId === null ? dutiesInForce(undefined, rowOf(draft)) : dutiesInForce(rowOf(draft), tenantRowOf(tenant))
}

/** What is in force as saved. */
export function dutiesSaved(rules: Rules, tenant: Rules | null): DutiesInForce {
  return rules.companyId === null ? dutiesInForce(undefined, rules.duties.own ? ownDuties(rules) : null) : dutiesInForce(rules.duties.own ? ownDuties(rules) : null, tenantRowOf(tenant))
}

export const dutiesLooseningsOf = (rules: Rules, tenant: Rules | null, draft: DutiesDraft): Loosening[] => dutiesLoosenings(dutiesSaved(rules, tenant), dutiesPreview(rules, tenant, draft))

export const dutiesChanges = (rules: Rules, draft: DutiesDraft): number => dutiesChanged(ownDuties(rules), rowOf(draft)).length

export function dutiesBody(rules: Rules, draft: DutiesDraft, reason: string | null): DutiesBody {
  return {
    companyId: rules.companyId,
    version: rules.version,
    releaseFourEyes: draft.releaseFourEyes,
    fourEyesConditions: [...draft.conditions].sort(),
    secondPersonPartyIds: [...draft.customers],
    placerMayRelease: draft.placerMayRelease,
    ...(reason ? { reason } : {}),
  }
}

/** How many customers of the saved list the draft takes off. */
export const removedCustomers = (rules: Rules, draft: DutiesDraft): number => ownDuties(rules).secondPersonPartyIds.filter((id) => !draft.customers.includes(id)).length

/** Tick or untick a condition of the scope's own list. */
export function withCondition(draft: DutiesDraft, condition: FourEyesCondition, on: boolean): DutiesDraft {
  const set = new Set(draft.conditions)
  if (on) set.add(condition)
  else set.delete(condition)
  return { ...draft, conditions: [...set].sort() }
}

/** A condition every company asks: a company's tick stays on and says why (it cannot drop it alone). */
export const conditionInherited = (rules: Rules, condition: FourEyesCondition): boolean => rules.companyId !== null && rules.duties.inForce.conditionsFromTenant.includes(condition)

/** The reason a looser rule needs: at least 3 characters (the API's reasonProblem), at most 1000. */
export const reasonHeld = (reason: string): string | null => (reason.trim().length < 3 ? 'loosen.reasonHeld' : reason.length > 1000 ? 'loosen.reasonLong' : null)

// ---- result rules -----------------------------------------------------------------------------------------------------------

export interface ResultsDraft {
  readonly stopAtRejectNumber: boolean | null
  /** null: follow; a whole number of seconds 0..300 (or the typed text while it is not one). */
  readonly benchUndoSeconds: number | null
}

const ownResults = (rules: Rules): ResultsRow => rules.results.own ?? { stopAtRejectNumber: null, benchUndoSeconds: null }
export const resultsDraftOf = (rules: Rules): ResultsDraft => ({ ...ownResults(rules) })
export const resultsChanges = (rules: Rules, draft: ResultsDraft): number => resultsChanged(ownResults(rules), draft).length
export function resultsPreview(rules: Rules, tenant: Rules | null, draft: ResultsDraft): ResultsInForce {
  return rules.companyId === null ? resultsInForce(undefined, draft) : resultsInForce(draft, tenant?.results.own ?? null)
}
export const resultsProblem = (draft: ResultsDraft): string | null => (benchUndoProblem(draft.benchUndoSeconds) ? 'results.undoRange' : null)
export const resultsBody = (rules: Rules, draft: ResultsDraft): ResultsBody => ({ companyId: rules.companyId, version: rules.version, stopAtRejectNumber: draft.stopAtRejectNumber, benchUndoSeconds: draft.benchUndoSeconds })

// ---- held reasons (said before the click) -----------------------------------------------------------------------------------

export function changeHeld(rules: Rules | null, busy: boolean, offline = false): string | null {
  if (!rules) return 'held.reading'
  if (!rules.mayChange) return rules.companyId === null ? 'held.noRightAll' : 'held.noRight'
  if (offline) return 'held.offline'
  if (busy) return 'held.busy'
  return null
}

// ---- alert rules ------------------------------------------------------------------------------------------------------------

export type WaitUnit = 'minutes' | 'hours' | 'days'

export interface RuleDraft {
  readonly id: string | null
  readonly version: number
  readonly companyId: string | null
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  readonly roleId: string | null
  /** The wait as typed, in `unit`. */
  readonly wait: string
  readonly unit: WaitUnit
  /** Days before a certificate's date, as typed ("180, 90, 30"). */
  readonly days: string
  readonly email: boolean
  readonly enabled: boolean
}

const UNIT_MINUTES: Readonly<Record<WaitUnit, number>> = Object.freeze({ minutes: 1, hours: 60, days: 1440 })

/** A wait in its largest whole unit (what the field shows). */
export function waitOf(minutes: number): { wait: string; unit: WaitUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { wait: String(minutes / 1440), unit: 'days' }
  if (minutes > 0 && minutes % 60 === 0) return { wait: String(minutes / 60), unit: 'hours' }
  return { wait: String(minutes), unit: 'minutes' }
}

export function ruleDraftOf(rule: AlertRule | null, defaults: { companyId: string | null; roleId: string | null }): RuleDraft {
  if (rule) {
    return { id: rule.id, version: rule.version, companyId: rule.companyId, event: rule.event, audience: rule.audience, roleId: rule.roleId, ...waitOf(rule.withinMinutes), days: rule.daysBefore.join(', '), email: rule.channels.includes('EMAIL'), enabled: rule.enabled }
  }
  return { id: null, version: 0, companyId: defaults.companyId, event: 'HOLD_PLACED', audience: 'OWNER', roleId: null, wait: '0', unit: 'minutes', days: '180, 90, 30', email: false, enabled: true }
}

/** Picking another event: a certificate tells a role and counts days; the others wait. */
export function withEvent(draft: RuleDraft, event: QualityAlertEvent, roleId: string | null): RuleDraft {
  const facts = EVENT_FACTS[event]
  const audience: AlertAudience = facts.owner === null ? 'ROLE' : draft.audience
  return { ...draft, event, audience, roleId: audience === 'OWNER' ? null : (draft.roleId ?? roleId), wait: facts.timing === 'DAYS' ? '0' : facts.timing === 'WAIT' && draft.wait === '0' ? '4' : draft.wait, unit: facts.timing === 'WAIT' && draft.wait === '0' ? 'hours' : draft.unit }
}

export const minutesOf = (draft: RuleDraft): number | null => {
  const text = draft.wait.trim()
  if (!/^\d{1,6}$/.test(text)) return null
  return Number(text) * UNIT_MINUTES[draft.unit]
}

export const daysOf = (draft: RuleDraft): number[] | null => {
  const parts = draft.days.split(/[,;\s/]+/).filter(Boolean)
  if (parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  return parts.map(Number)
}

const domainDraft = (draft: RuleDraft): AlertRuleDraft => ({
  event: draft.event,
  audience: draft.audience,
  roleId: draft.audience === 'OWNER' ? null : draft.roleId,
  withinMinutes: EVENT_FACTS[draft.event].timing === 'DAYS' ? 0 : (minutesOf(draft) ?? -1),
  daysBefore: EVENT_FACTS[draft.event].timing === 'DAYS' ? (daysOf(draft) ?? [-1]) : [],
  channels: draft.email ? ['IN_APP', 'EMAIL'] : ['IN_APP'],
})

/** The draft's problems at its fields (factory-domain's own checks), as `quality-rules` keys. */
export function ruleProblems(draft: RuleDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of alertRuleProblems(domainDraft(draft))) {
    const field = issue.path === 'withinMinutes' ? 'wait' : issue.path === 'daysBefore' ? 'days' : issue.path
    if (!out[field]) out[field] = `ruleDialog.problem.${field}`
  }
  return out
}

export function ruleBody(draft: RuleDraft): AlertRuleBody {
  const shape = domainDraft(draft)
  return { companyId: draft.companyId, event: draft.event, audience: shape.audience, roleId: shape.roleId, withinMinutes: shape.withinMinutes, daysBefore: sortedDays(shape.daysBefore), channels: [...shape.channels], enabled: draft.enabled }
}

/** What an edit sends: only what changed (the company and the event never change). */
export function ruleEdit(rule: AlertRule, draft: RuleDraft): AlertRuleEdit {
  const body = ruleBody(draft)
  const edit: AlertRuleEdit = {}
  if (body.audience !== rule.audience) edit.audience = body.audience
  if (body.roleId !== rule.roleId) edit.roleId = body.roleId
  if (body.withinMinutes !== rule.withinMinutes) edit.withinMinutes = body.withinMinutes
  if (body.daysBefore.join(',') !== rule.daysBefore.join(',')) edit.daysBefore = body.daysBefore
  if (body.channels.join(',') !== rule.channels.join(',')) edit.channels = body.channels
  if (body.enabled !== rule.enabled) edit.enabled = body.enabled
  return edit
}

/** The draft as its sentence in the page's language (the same words the API answers). */
export function draftSentence(draft: RuleDraft, roles: AlertRules['roles'], locale: string): string {
  const shape = domainDraft(draft)
  const role = roles.find((entry) => entry.id === shape.roleId)?.name ?? null
  return alertRuleSentence({ ...shape, withinMinutes: Math.max(0, shape.withinMinutes), daysBefore: shape.daysBefore.filter((day) => day > 0) }, role, locale)
}

export const EVENTS = QUALITY_ALERT_EVENTS
export const DAYS_MAX = ALERT_LIMITS.daysBeforeMax

/** The rules a bulk switch would change (held when none would). */
export function bulkHeld(rules: readonly AlertRule[], selected: readonly string[], enabled: boolean, mayManage: boolean, busy: boolean): string | null {
  if (!mayManage) return 'held.noAlertRight'
  if (busy) return 'held.busy'
  const picked = rules.filter((rule) => selected.includes(rule.id))
  if (picked.length === 0) return 'held.pickRows'
  if (!picked.some((rule) => rule.enabled !== enabled)) return enabled ? 'held.allOn' : 'held.allOff'
  return null
}

// ---- refusals in our words ------------------------------------------------------------------------------------------------

/** An API refusal (or no answer) in this page's words: a `quality-rules` key. */
export function problemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.failed'
  const paths = error.issues.map((issue) => issuePath(issue))
  switch (error.kind) {
    case 'conflict':
      return paths.includes('version') || /changed|version/i.test(error.message) ? 'problem.stale' : 'problem.conflict'
    case 'invalid': {
      if (paths.includes('body/reason')) return 'problem.reason'
      if (paths.includes('body/version')) return 'problem.changedMeanwhile'
      if (paths.includes('body/secondPersonPartyIds')) return 'problem.customers'
      if (paths.includes('body/benchUndoSeconds')) return 'results.undoRange'
      const field = paths.map((path) => path.replace(/^body\//, '')).find((path) => ['roleId', 'audience', 'withinMinutes', 'daysBefore', 'channels', 'companyId'].includes(path))
      return field ? `ruleDialog.problem.${field === 'withinMinutes' ? 'wait' : field === 'daysBefore' ? 'days' : field}` : 'problem.invalid'
    }
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.gone'
    case 'signed_out':
      return 'problem.signedOut'
    case 'unavailable':
      return 'problem.offline'
    default:
      return 'problem.failed'
  }
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.readForbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  return 'problem.read'
}

// ---- live ----------------------------------------------------------------------------------------------------------------

export const LIVE_EVENTS = ['quality.rules_changed', 'quality.alert_rule_changed', 'quality.alert_fired', 'quality.release_rule_changed', 'quality.hold_rule_changed'] as const
