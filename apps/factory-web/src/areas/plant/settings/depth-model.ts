import { H1_SETTINGS, loosens } from '@nexus/factory-domain/plant/requests/lock'
import { ROUTING_LIMITS } from '@nexus/factory-domain/plant/requests/routing'
import { PLANT_CODE } from '@nexus/factory-domain/plant/rules'
import { CHECK_LIMITS, INTERVAL_MAX, MAX_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { movedOrder } from '@nexus/factory-domain/reasons/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CheckType, CheckTypeFields, IntervalUnit, LockBody, LockBy, LockRead, RoutingRule, RuleFields, SignSafeBy } from './depth-api'

/**
 * Plant settings' W2b sections (SCR-241; design plant.settings sec:routing, sec:lock, sec:checks, sec:incidents), pure:
 * the drafts each dialog or card edits, what a save sends (only what changed, at the version read), what holds a button
 * and why (`plant-settings` keys), the worked example of a routing rule in words, the new order of the rules, and an API
 * refusal in this page's words. The domain's own rules (factory-domain plant/requests routing + lock, plant/statutory
 * rules) stay the last word: the tests hold that what passes here passes there.
 */

/** A message key and its params (the view says it in the page's language). */
export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- request routing and escalation -------------------------------------------------------------------------------------------

export type TargetKind = 'TEAM' | 'TECHNICIAN'

/** The rule dialog's draft: the switches stay with their values while off, so turning one back on keeps what was typed. */
export interface RuleDraft {
  /** null: a new rule. */
  readonly id: string | null
  readonly version: number | null
  /** null: every machine type (the fallback). */
  readonly machineClassId: string | null
  readonly targetKind: TargetKind
  readonly teamId: string | null
  readonly technicianId: string | null
  /** The chosen target's name, for the example and when the pickers cannot be read. */
  readonly targetName: string | null
  readonly push: boolean
  readonly escalate: boolean
  readonly escalateAfterMinutes: number
  readonly escalateToId: string | null
  readonly escalateToName: string | null
  readonly again: boolean
  readonly escalateAgainAfterMinutes: number
  readonly escalateAgainToId: string | null
  readonly escalateAgainToName: string | null
  readonly active: boolean
}

/** The minutes a new escalation offers first: a starting point the person changes, not a rule. */
export const FIRST_MINUTES = 10
export const AGAIN_MINUTES = 30

export function blankRule(machineClassId: string | null = null): RuleDraft {
  return {
    id: null,
    version: null,
    machineClassId,
    targetKind: 'TEAM',
    teamId: null,
    technicianId: null,
    targetName: null,
    push: true,
    escalate: false,
    escalateAfterMinutes: FIRST_MINUTES,
    escalateToId: null,
    escalateToName: null,
    again: false,
    escalateAgainAfterMinutes: AGAIN_MINUTES,
    escalateAgainToId: null,
    escalateAgainToName: null,
    active: true,
  }
}

export function ruleDraftOf(rule: RoutingRule): RuleDraft {
  return {
    id: rule.id,
    version: rule.version,
    machineClassId: rule.machineClass?.id ?? null,
    targetKind: rule.target.kind,
    teamId: rule.target.kind === 'TEAM' ? rule.target.id : null,
    technicianId: rule.target.kind === 'TECHNICIAN' ? rule.target.id : null,
    targetName: rule.target.name,
    push: rule.push,
    escalate: rule.escalateAfterMinutes !== null,
    escalateAfterMinutes: rule.escalateAfterMinutes ?? FIRST_MINUTES,
    escalateToId: rule.escalateTo?.id ?? null,
    escalateToName: rule.escalateTo?.name ?? null,
    again: rule.escalateAgainAfterMinutes !== null,
    escalateAgainAfterMinutes: rule.escalateAgainAfterMinutes ?? AGAIN_MINUTES,
    escalateAgainToId: rule.escalateAgainTo?.id ?? null,
    escalateAgainToName: rule.escalateAgainTo?.name ?? null,
    active: rule.active,
  }
}

/** The rule as the API keeps it: a switch that is off sends null; exactly one of team and technician. */
export function ruleFieldsOf(draft: RuleDraft): Required<RuleFields> {
  const first = draft.escalate
  const again = first && draft.again
  return {
    machineClassId: draft.machineClassId,
    teamId: draft.targetKind === 'TEAM' ? draft.teamId : null,
    technicianId: draft.targetKind === 'TECHNICIAN' ? draft.technicianId : null,
    push: draft.push,
    escalateAfterMinutes: first ? draft.escalateAfterMinutes : null,
    escalateToId: first ? draft.escalateToId : null,
    escalateAgainAfterMinutes: again ? draft.escalateAgainAfterMinutes : null,
    escalateAgainToId: again ? draft.escalateAgainToId : null,
    active: draft.active,
  }
}

const minutesOk = (value: number) => Number.isInteger(value) && value >= ROUTING_LIMITS.minMinutes && value <= ROUTING_LIMITS.maxMinutes

/** Why "Save rule" is held (a `plant-settings` key), or null. The same rules as factory-domain's ruleProblems, in order. */
export function ruleHeld(draft: RuleDraft, busy: boolean): string | null {
  if (busy) return 'held.busy'
  const fields = ruleFieldsOf(draft)
  if ((fields.teamId === null) === (fields.technicianId === null)) return draft.targetKind === 'TEAM' ? 'held.noTeam' : 'held.noTechnician'
  if (draft.escalate) {
    if (!minutesOk(draft.escalateAfterMinutes)) return 'held.minutes'
    if (!draft.escalateToId) return 'held.noEscalateTo'
    if (draft.again) {
      if (!minutesOk(draft.escalateAgainAfterMinutes)) return 'held.minutes'
      if (draft.escalateAgainAfterMinutes <= draft.escalateAfterMinutes) return 'held.againLater'
      if (!draft.escalateAgainToId) return 'held.noAgainTo'
    }
  }
  return null
}

/** What a change of an existing rule sends: only the fields that differ from the rule as read (a target replaces the other). */
export function ruleChanges(rule: RoutingRule, draft: RuleDraft): RuleFields {
  const before = ruleFieldsOf(ruleDraftOf(rule))
  const after = ruleFieldsOf(draft)
  const changes: RuleFields = {}
  if (after.machineClassId !== before.machineClassId) changes.machineClassId = after.machineClassId
  if (after.teamId !== before.teamId || after.technicianId !== before.technicianId) {
    if (after.teamId) changes.teamId = after.teamId
    else if (after.technicianId) changes.technicianId = after.technicianId
  }
  for (const field of ['push', 'escalateAfterMinutes', 'escalateToId', 'escalateAgainAfterMinutes', 'escalateAgainToId', 'active'] as const) {
    if (after[field] !== before[field]) (changes as Record<string, unknown>)[field] = after[field]
  }
  return changes
}

/** How many fields a rule's change sends (0: nothing to save). */
export const ruleChangeCount = (rule: RoutingRule | null, draft: RuleDraft): number => (rule ? Object.keys(ruleChanges(rule, draft)).length : 1)

/** What a new rule sends. */
export function ruleAddBody(siteId: string, draft: RuleDraft): RuleFields & { siteId: string } {
  const fields = ruleFieldsOf(draft)
  const body: RuleFields & { siteId: string } = { siteId, machineClassId: fields.machineClassId, push: fields.push, active: fields.active }
  if (fields.teamId) body.teamId = fields.teamId
  if (fields.technicianId) body.technicianId = fields.technicianId
  if (fields.escalateAfterMinutes !== null) {
    body.escalateAfterMinutes = fields.escalateAfterMinutes
    body.escalateToId = fields.escalateToId
  }
  if (fields.escalateAgainAfterMinutes !== null) {
    body.escalateAgainAfterMinutes = fields.escalateAgainAfterMinutes
    body.escalateAgainToId = fields.escalateAgainToId
  }
  return body
}

/** The facts the worked example says (names already in words). */
export interface ExampleFacts {
  /** The machine type's words; null: any machine (every class). */
  readonly machineClass: string | null
  readonly site: string
  /** null: no rule matches. */
  readonly target: { readonly kind: TargetKind; readonly name: string } | null
  /** null: not known (the API's preview does not say it): no sentence about the notice. */
  readonly push: boolean | null
  readonly escalate: { readonly minutes: number; readonly to: string } | null
  readonly again: { readonly minutes: number; readonly to: string } | null
  /** false: the rule is switched off (requests skip it). */
  readonly active: boolean
}

/**
 * The worked example in words (design "Preview in words: 'A thread-breaks request on a lockstitch at Site A at 14:10 goes
 * to the sewing-machine team …; not acknowledged in 10 min → Supervisor Line A'"): one sentence per fact, in the page's
 * language. Who is on shift is not read (B-W2b-96: a team's notice goes to its members today), so it is not claimed.
 */
export function exampleOf(facts: ExampleFacts): Said[] {
  const lines: Said[] = []
  if (!facts.active) lines.push({ key: 'routing.example.off' })
  const what: Record<string, string> = facts.machineClass === null ? { site: facts.site } : { class: facts.machineClass, site: facts.site }
  if (!facts.target) {
    lines.push({ key: facts.machineClass === null ? 'routing.example.noneAny' : 'routing.example.noneClass', params: what })
    return lines
  }
  const target = facts.target.kind === 'TEAM' ? 'team' : 'person'
  lines.push({ key: facts.machineClass === null ? `routing.example.goesAny.${target}` : `routing.example.goesClass.${target}`, params: { ...what, target: facts.target.name } })
  if (facts.push !== null) lines.push({ key: `routing.example.${facts.push ? 'push' : 'quiet'}.${target}` })
  if (facts.escalate) lines.push({ key: 'routing.example.escalate', params: { minutes: facts.escalate.minutes, person: facts.escalate.to } })
  if (facts.again) lines.push({ key: 'routing.example.again', params: { minutes: facts.again.minutes, person: facts.again.to } })
  if (!facts.escalate) lines.push({ key: 'routing.example.noEscalation' })
  return lines
}

/** The example of a rule as read. */
export function ruleExample(rule: Pick<RoutingRule, 'target' | 'escalateAfterMinutes' | 'escalateTo' | 'escalateAgainAfterMinutes' | 'escalateAgainTo'> & { push?: boolean | null; active?: boolean }, machineClass: string | null, site: string): Said[] {
  return exampleOf({
    machineClass,
    site,
    target: { kind: rule.target.kind, name: rule.target.name },
    push: rule.push ?? null,
    escalate: rule.escalateAfterMinutes !== null && rule.escalateTo ? { minutes: rule.escalateAfterMinutes, to: rule.escalateTo.name } : null,
    again: rule.escalateAgainAfterMinutes !== null && rule.escalateAgainTo ? { minutes: rule.escalateAgainAfterMinutes, to: rule.escalateAgainTo.name } : null,
    active: rule.active ?? true,
  })
}

/** The example of the dialog's draft, before it is saved (design "Routing shows a worked example in words before you save"). */
export function draftExample(draft: RuleDraft, machineClass: string | null, site: string): Said[] {
  const id = draft.targetKind === 'TEAM' ? draft.teamId : draft.technicianId
  const fields = ruleFieldsOf(draft)
  return exampleOf({
    machineClass,
    site,
    target: id && draft.targetName ? { kind: draft.targetKind, name: draft.targetName } : null,
    push: draft.push,
    escalate: fields.escalateAfterMinutes !== null && draft.escalateToName ? { minutes: fields.escalateAfterMinutes, to: draft.escalateToName } : null,
    again: fields.escalateAgainAfterMinutes !== null && draft.escalateAgainToName ? { minutes: fields.escalateAgainAfterMinutes, to: draft.escalateAgainToName } : null,
    active: draft.active,
  })
}

/** The rules' order after moving the chosen ones one place, or null when nothing would move. */
export function ruleOrderAfter(rules: readonly Pick<RoutingRule, 'id'>[], chosen: readonly string[], delta: -1 | 1): string[] | null {
  const order = rules.map((rule) => rule.id)
  const next = movedOrder(order, chosen, delta)
  return next.every((id, index) => id === order[index]) ? null : next
}

/** Why Move up / Move down is held, or null. */
export function ruleMoveHeld(rules: readonly Pick<RoutingRule, 'id'>[], chosen: readonly string[], delta: -1 | 1, busy: boolean): string | null {
  if (busy) return 'held.busy'
  return ruleOrderAfter(rules, chosen, delta) ? null : delta === -1 ? 'held.atTop' : 'held.atBottom'
}

/** What POST …/order sends: every rule of the site in the new order, each at its version. */
export function orderBody(rules: readonly Pick<RoutingRule, 'id' | 'version'>[], order: readonly string[]): { id: string; version: number }[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule.version]))
  return order.map((id) => ({ id, version: byId.get(id)! }))
}

/** Why "Switch on N" / "Switch off N" is held, or null. */
export function ruleSwitchHeld(picked: readonly Pick<RoutingRule, 'active'>[], active: boolean, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!picked.some((rule) => rule.active !== active)) return active ? 'held.allOn' : 'held.allOff'
  return null
}

/** What Remove does to these rules: those a request names are switched off (kept), the others deleted. */
export function removeOutcome(rules: readonly Pick<RoutingRule, 'requests' | 'active'>[]): { deleted: number; switchedOff: number; offAlready: number } {
  const used = rules.filter((rule) => rule.requests > 0)
  return { deleted: rules.length - used.length, switchedOff: used.filter((rule) => rule.active).length, offAlready: used.filter((rule) => !rule.active).length }
}

// ---- the unsafe lock ------------------------------------------------------------------------------------------------------------

export interface LockDraft {
  readonly lockBy: LockBy
  readonly signSafeBy: SignSafeBy
  readonly hazardReportOnLock: boolean
}

export const lockDraftOf = (read: Pick<LockRead, 'lockBy' | 'signSafeBy' | 'hazardReportOnLock'>): LockDraft => ({ lockBy: read.lockBy, signSafeBy: read.signSafeBy, hazardReportOnLock: read.hazardReportOnLock })

/** How many of the three settings differ from what was read. */
export function lockChangeCount(read: LockDraft, draft: LockDraft): number {
  return (['lockBy', 'signSafeBy', 'hazardReportOnLock'] as const).filter((field) => read[field] !== draft[field]).length
}

/** Why Apply is held: Owner answer H1 holds both choices (the database and the API hold the same), or a save under way. */
export function lockHeld(draft: LockDraft, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (draft.lockBy !== H1_SETTINGS.lockBy) return 'held.h1Lock'
  if (draft.signSafeBy !== H1_SETTINGS.signSafeBy) return 'held.h1SignSafe'
  return null
}

/** Whether the change loosens a safety rule (the API asks the office's fresh code: the hazard report switched off). */
export const lockLoosens = (read: LockDraft, draft: LockDraft): boolean => loosens(read, draft)

/** What PUT sends: the three settings and the version read (null: the site had no row, it is made). */
export const lockBody = (siteId: string, read: Pick<LockRead, 'version'>, draft: LockDraft): LockBody => ({ siteId, version: read.version, lockBy: draft.lockBy, signSafeBy: draft.signSafeBy, hazardReportOnLock: draft.hazardReportOnLock })

// ---- statutory check types ------------------------------------------------------------------------------------------------------

export type TypeRows = 'active' | 'retired' | 'all'
export const TYPE_ROWS: readonly TypeRows[] = ['active', 'retired', 'all']

export interface TypeDraft {
  /** null: a new type. */
  readonly id: string | null
  readonly version: number | null
  readonly code: string
  /** null: any machine. Fixed once added. */
  readonly classId: string | null
  readonly labelIt: string
  readonly labelEn: string
  readonly legalBasis: string
  /** null: not typed yet (no interval is offered: the law of each check is the office's to type). */
  readonly defaultInterval: number | null
  readonly defaultIntervalUnit: IntervalUnit
  readonly outsideBody: boolean
  readonly retentionYears: number
}

/** A new type: no interval offered; kept for the law's least years as the API says them. */
export function blankType(leastRetentionYears: number): TypeDraft {
  return { id: null, version: null, code: '', classId: null, labelIt: '', labelEn: '', legalBasis: '', defaultInterval: null, defaultIntervalUnit: 'MONTH', outsideBody: false, retentionYears: leastRetentionYears }
}

export function typeDraftOf(type: CheckType): TypeDraft {
  return {
    id: type.id,
    version: type.version,
    code: type.code,
    classId: type.machineClass?.id ?? null,
    labelIt: type.labelIt,
    labelEn: type.labelEn,
    legalBasis: type.legalBasis,
    defaultInterval: type.defaultInterval,
    defaultIntervalUnit: type.defaultIntervalUnit,
    outsideBody: type.outsideBody,
    retentionYears: type.retentionYears,
  }
}

/** Why "Add check type" / "Save" is held (a `plant-settings` key), or null: factory-domain checkTypeProblems' rules in order. */
export function typeHeld(draft: TypeDraft, codes: readonly string[], leastRetentionYears: number, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (draft.id === null) {
    // The API takes the code in capitals (it upper-cases it), as the field types it.
    const code = draft.code.trim().toUpperCase()
    if (!code) return 'held.noCode'
    if (!PLANT_CODE.test(code)) return 'held.badCode'
    if (codes.includes(code)) return 'held.typeTaken'
  }
  if (!draft.labelIt.trim() || !draft.labelEn.trim()) return 'held.noTypeWords'
  if (draft.labelIt.trim().length > CHECK_LIMITS.label || draft.labelEn.trim().length > CHECK_LIMITS.label) return 'problem.tooLong'
  if (!draft.legalBasis.trim()) return 'held.noLaw'
  if (draft.legalBasis.trim().length > CHECK_LIMITS.legalBasis) return 'held.lawTooLong'
  if (draft.defaultInterval === null) return 'held.noInterval'
  if (!Number.isInteger(draft.defaultInterval) || draft.defaultInterval < 1 || draft.defaultInterval > INTERVAL_MAX[draft.defaultIntervalUnit]) return 'held.intervalMax'
  if (!Number.isInteger(draft.retentionYears) || draft.retentionYears < leastRetentionYears || draft.retentionYears > MAX_RETENTION_YEARS) return 'held.retention'
  return null
}

/** What a new type sends (trimmed; the code in capitals). */
export function typeCreateBody(draft: TypeDraft) {
  return {
    code: draft.code.trim().toUpperCase(),
    classId: draft.classId,
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    legalBasis: draft.legalBasis.trim(),
    defaultInterval: draft.defaultInterval ?? 1,
    defaultIntervalUnit: draft.defaultIntervalUnit,
    outsideBody: draft.outsideBody,
    retentionYears: draft.retentionYears,
  }
}

/** What a change of a type sends: only what differs (code and class never change). */
export function typeChanges(type: CheckType, draft: TypeDraft): CheckTypeFields {
  const changes: CheckTypeFields = {}
  if (draft.labelIt.trim() !== type.labelIt) changes.labelIt = draft.labelIt.trim()
  if (draft.labelEn.trim() !== type.labelEn) changes.labelEn = draft.labelEn.trim()
  if (draft.legalBasis.trim() !== type.legalBasis) changes.legalBasis = draft.legalBasis.trim()
  if (draft.defaultInterval !== null && draft.defaultInterval !== type.defaultInterval) changes.defaultInterval = draft.defaultInterval
  if (draft.defaultIntervalUnit !== type.defaultIntervalUnit) changes.defaultIntervalUnit = draft.defaultIntervalUnit
  if (draft.outsideBody !== type.outsideBody) changes.outsideBody = draft.outsideBody
  if (draft.retentionYears !== type.retentionYears) changes.retentionYears = draft.retentionYears
  return changes
}

/** The largest interval a unit takes (the database's factory_plant_interval_ok). */
export const intervalMaxOf = (unit: IntervalUnit): number => INTERVAL_MAX[unit]

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The types a filter and a search keep (code, words in both languages, the law). */
export function visibleTypes(types: readonly CheckType[], rows: TypeRows, query: string): CheckType[] {
  const q = fold(query.trim())
  return types.filter((type) => {
    if (rows === 'active' && !type.active) return false
    if (rows === 'retired' && type.active) return false
    if (!q) return true
    return [type.code, type.labelIt, type.labelEn, type.legalBasis].some((text) => fold(text).includes(q))
  })
}

/** Why "Retire N" / "Make N active again" is held, or null. */
export function typeStateHeld(picked: readonly Pick<CheckType, 'active'>[], active: boolean, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!picked.some((type) => type.active !== active)) return active ? 'held.allActive' : 'held.allRetired'
  return null
}

export const typeRowsOf = (asked: string | null | undefined): TypeRows => (asked === 'retired' || asked === 'all' ? asked : 'active')

// ---- the API's refusals in this page's words ------------------------------------------------------------------------------------

/** The refusal codes these sections say in their own words (409 `refusal/<CODE>`). */
export const DEPTH_SETTINGS_REFUSALS = ['H1_HELD', 'ORDER_INCOMPLETE', 'TYPE_TAKEN', 'TOO_MANY_TYPES'] as const

/** The body fields whose 400 these sections say at the field. */
export const DEPTH_FIELDS = [
  'machineClassId',
  'teamId',
  'technicianId',
  'escalateAfterMinutes',
  'escalateToId',
  'escalateAgainAfterMinutes',
  'escalateAgainToId',
  'code',
  'classId',
  'labelIt',
  'labelEn',
  'legalBasis',
  'defaultInterval',
  'retentionYears',
] as const

export interface DepthProblem extends Said {
  /** The field it belongs to (a 400 naming it, or a code taken). */
  readonly field?: string
  /** No answer: the change may or may not have been made. */
  readonly unknown: boolean
}

/** A failed write in this page's words (`plant-settings` keys): a refusal by its code, a field, else the kind of failure. */
export function depthProblemOf(error: unknown): DepthProblem {
  if (!isApiError(error)) return { key: 'problem.failed', unknown: true }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((DEPTH_SETTINGS_REFUSALS as readonly string[]).includes(code)) return { key: `refusal.${code}`, unknown: false, ...(code === 'TYPE_TAKEN' ? { field: 'code' } : {}) }
    return { key: 'problem.refused', unknown: false }
  }
  switch (error.kind) {
    case 'conflict': {
      const said = `${error.message ?? ''} ${error.issues.map((issue) => issue.message ?? '').join(' ')}`
      return { key: /at most/i.test(said) ? 'problem.tooManyRules' : 'problem.staleSettings', unknown: false }
    }
    case 'invalid': {
      const field = error.issues.map((issue) => issuePath(issue).replace(/^(body|query)[./]/, '').split(/[./]/)[0]).find((name) => (DEPTH_FIELDS as readonly string[]).includes(name ?? ''))
      return field ? { key: `field.${field}`, field, unknown: false } : { key: 'problem.invalid', unknown: false }
    }
    case 'forbidden':
      return { key: 'problem.forbiddenSettings', unknown: false }
    case 'step_up':
      return { key: 'problem.stepUp', unknown: false }
    case 'not_found':
      return { key: 'problem.goneSettings', unknown: false }
    case 'signed_out':
      return { key: 'problem.signedOut', unknown: false }
    case 'rate_limited':
      return { key: 'problem.busyServer', unknown: false }
    case 'unavailable':
      return { key: 'problem.offlineSettings', unknown: true }
    default:
      return { key: 'problem.failed', unknown: true }
  }
}

/** A section's read that failed, in words (never drawn as empty). */
export function depthReadProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.readForbiddenSection'
  if (error.kind === 'unavailable') return 'problem.offlineSettings'
  if (error.kind === 'not_found') return 'problem.goneSettings'
  return 'problem.read'
}

// ---- the audit log ----------------------------------------------------------------------------------------------------------------

/** The actions the audit log says in words; any other is "Another change". */
export const HISTORY_ACTIONS = [
  'addRoutingRule',
  'changeRoutingRule',
  'removeRoutingRule',
  'orderRoutingRules',
  'setLockSettings',
  'createCheckType',
  'updateCheckType',
  'createSymptom',
  'updateSymptom',
  'createClass',
  'updateClass',
  'addStarter',
] as const

const recordOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** One audit row in words: the action (with what the row says it did) and the code it names, if any. */
export function historyWords(entry: { action: string; before?: unknown; after?: unknown }): Said {
  const name = entry.action.replace(/^plant\./, '')
  const before = recordOf(entry.before)
  const after = recordOf(entry.after)
  const code = typeof after.code === 'string' ? after.code : typeof before.code === 'string' ? before.code : null
  if (name === 'removeRoutingRule') return { key: after.outcome === 'DELETED' ? 'history.action.ruleDeleted' : 'history.action.ruleSwitchedOff' }
  if (name === 'setLockSettings') {
    if (after.unchanged === true) return { key: 'history.action.lockUnchanged' }
    if (before.hazardReportOnLock === true && after.hazardReportOnLock === false) return { key: 'history.action.hazardOff' }
    if (before.hazardReportOnLock === false && after.hazardReportOnLock === true) return { key: 'history.action.hazardOn' }
    return { key: 'history.action.setLockSettings' }
  }
  if (name === 'updateCheckType' && code) {
    if (before.active === true && after.active === false) return { key: 'history.action.typeRetired', params: { code } }
    if (before.active === false && after.active === true) return { key: 'history.action.typeRestored', params: { code } }
    return { key: 'history.action.updateCheckTypeCode', params: { code } }
  }
  if (name === 'changeRoutingRule' && after.unchanged === true) return { key: 'history.action.ruleUnchanged' }
  if (!(HISTORY_ACTIONS as readonly string[]).includes(name)) return { key: 'history.action.other' }
  return code ? { key: `history.action.${name}Code`, params: { code } } : { key: `history.action.${name}` }
}
