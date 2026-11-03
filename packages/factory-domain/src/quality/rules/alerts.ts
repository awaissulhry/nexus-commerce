import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { Permission } from '../../core/permissions'
import { wordsIn, type Words } from './duties'

/**
 * Quality alerts and escalation (B-W2b-118; QHS-154; design quality.settings qs-alerts "Who gets what and how fast"), pure.
 * A rule (QualityAlertRule, B-W2b-79's table) says WHEN (one of seven events), WHOM (the record's owner, the holders of an
 * office role over the record's company, or both), HOW FAST (at once, after a wait, or so many days before a date) and HOW
 * (the bell; e-mail through the person's digest of the bell). A rule is a company's or every company's: for a company and
 * an event, its own rules apply when it has any, else the rules of every company (`rulesInForce`, as B-W2b-108's CAPA
 * escalation reads CAPA_ACTION_OVERDUE).
 *
 * How each event fires (EVENT_FACTS.timing):
 *   EVENT       at once on the record's own event (a hold placed, a critical NCR raised, a complaint found about safety);
 *               with a wait: once the record is still so after the wait (the hold still on hold, the NCR still open, the
 *               safety complaint still not acknowledged)
 *   WAIT        once the record has waited longer than the rule's time (an inspection not signed, a passed inspection whose
 *               release still waits for its second person)
 *   DAYS        so many days before the certificate's last valid day (180 / 90 / 30): once per step, only the latest step
 *               reached when several are (a new rule never tells three times at once)
 *   ESCALATION  B-W2b-108's CAPA reminders: an overdue corrective action escalates once, as tasks (this step only keeps
 *               the rule)
 * Every firing tells once per rule, record and step (the API keeps it on the rule's audit trail).
 */

export const QUALITY_ALERT_EVENTS = ['HOLD_PLACED', 'CRITICAL_NCR', 'SAFETY_COMPLAINT', 'INSPECTION_WAITING', 'CERTIFICATE_EXPIRING', 'RELEASE_WAITING_SECOND_PERSON', 'CAPA_ACTION_OVERDUE'] as const
export type QualityAlertEvent = (typeof QUALITY_ALERT_EVENTS)[number]
export const ALERT_AUDIENCES = ['OWNER', 'ROLE', 'OWNER_AND_ROLE'] as const
export type AlertAudience = (typeof ALERT_AUDIENCES)[number]
export const ALERT_CHANNELS = ['IN_APP', 'EMAIL'] as const
export type AlertChannel = (typeof ALERT_CHANNELS)[number]

export const ALERT_LIMITS = Object.freeze({ withinMinutesMax: 43_200, daysBeforeMin: 1, daysBeforeMax: 730, daysBeforeCount: 6, rulesPerScope: 50 })
/** A firing reaches back at most this far (a wait crossed or a date step reached longer ago is never told late). */
export const FIRING_LOOKBACK_MS = 7 * 24 * 60 * 60_000

export type AlertTiming = 'EVENT' | 'WAIT' | 'DAYS' | 'ESCALATION'
export type AlertRecordType = 'QualityHold' | 'Nonconformance' | 'Complaint' | 'Inspection' | 'IncomingInspection' | 'Certificate' | 'CapaAction'

const w = (it: string, en: string): Words => Object.freeze({ it, en })

export interface EventFacts {
  readonly timing: AlertTiming
  /** The records it fires on. */
  readonly records: readonly AlertRecordType[]
  /** Who OWNER is for it; null: the record names nobody (a role only). */
  readonly owner: Words | null
  /** The permission a person told needs over the record (with home.view for the bell). */
  readonly view: Permission
  /** "When …" words: `{wait}` and `{days}` filled in. */
  readonly when: Words
  /** With a wait (EVENT rules only): "When … still … after {wait}". */
  readonly whenWaited?: Words
  /** The words of a firing in the bell's sentence ("Alert on HLD-2026-0004: {title}"). */
  readonly told: Words
  readonly toldWaited?: Words
}

export const EVENT_FACTS: Readonly<Record<QualityAlertEvent, EventFacts>> = Object.freeze({
  HOLD_PLACED: {
    timing: 'EVENT',
    records: ['QualityHold'],
    owner: w('il responsabile del blocco', "the hold's owner"),
    view: 'quality.holds.view',
    when: w('Quando della merce viene bloccata', 'When goods are put on hold'),
    whenWaited: w('Quando della merce è ancora bloccata {wait} dopo il blocco', 'When goods are still on hold {wait} after they were held'),
    told: w('merce messa in blocco (regola qualità)', 'goods put on hold (quality rule)'),
    toldWaited: w('ancora in blocco dopo {wait} (regola qualità)', 'still on hold after {wait} (quality rule)'),
  },
  CRITICAL_NCR: {
    timing: 'EVENT',
    records: ['Nonconformance'],
    owner: w('il responsabile della NC', "the NCR's owner"),
    view: 'quality.ncr.view',
    when: w('Quando viene aperta una NC critica', 'When a critical NCR is raised'),
    whenWaited: w('Quando una NC critica è ancora aperta {wait} dopo l’apertura', 'When a critical NCR is still open {wait} after it was raised'),
    told: w('NC critica aperta (regola qualità)', 'critical NCR raised (quality rule)'),
    toldWaited: w('NC critica ancora aperta dopo {wait} (regola qualità)', 'critical NCR still open after {wait} (quality rule)'),
  },
  SAFETY_COMPLAINT: {
    timing: 'EVENT',
    records: ['Complaint'],
    owner: w('il responsabile del reclamo', "the complaint's owner"),
    view: 'quality.complaints.view',
    when: w('Quando un reclamo riguarda la sicurezza', 'When a complaint is found to be about safety'),
    whenWaited: w('Quando un reclamo di sicurezza non è ancora preso in carico {wait} dopo', 'When a safety complaint is still not acknowledged {wait} after it was raised'),
    told: w('reclamo di sicurezza (regola qualità)', 'safety complaint (quality rule)'),
    toldWaited: w('reclamo di sicurezza non preso in carico dopo {wait} (regola qualità)', 'safety complaint not acknowledged after {wait} (quality rule)'),
  },
  INSPECTION_WAITING: {
    timing: 'WAIT',
    records: ['Inspection', 'IncomingInspection'],
    owner: w("l'ispettore a cui è assegnata", 'the inspector it is assigned to'),
    view: 'quality.inspections.view',
    when: w('Quando un’ispezione aspetta da più di {wait} di essere firmata', 'When an inspection waits more than {wait} to be signed'),
    told: w('ispezione in attesa da più di {wait} (regola qualità)', 'inspection waiting for more than {wait} (quality rule)'),
  },
  CERTIFICATE_EXPIRING: {
    timing: 'DAYS',
    records: ['Certificate'],
    owner: null,
    view: 'compliance.certificates.view',
    when: w('Quando un certificato scade tra {days} giorni', 'When a certificate expires in {days} days'),
    told: w('il certificato scade tra {days} giorni, il {date} (regola qualità)', 'the certificate expires in {days} days, on {date} (quality rule)'),
  },
  RELEASE_WAITING_SECOND_PERSON: {
    timing: 'WAIT',
    records: ['Inspection'],
    owner: w("l'ispettore che ha firmato il risultato", 'the inspector who signed the result'),
    view: 'quality.inspections.view',
    when: w('Quando un rilascio aspetta la seconda persona da più di {wait}', 'When a release waits more than {wait} for its second person'),
    told: w('il rilascio aspetta la seconda persona da più di {wait} (regola qualità)', 'the release waits for its second person for more than {wait} (quality rule)'),
  },
  CAPA_ACTION_OVERDUE: {
    timing: 'ESCALATION',
    records: ['CapaAction'],
    owner: w('il responsabile della CAPA', "the CAPA's owner"),
    view: 'quality.capa.view',
    when: w('Quando un’azione correttiva è scaduta da più di {wait}', 'When a corrective action is overdue by more than {wait}'),
    told: w('azione correttiva scaduta (regola qualità)', 'corrective action overdue (quality rule)'),
  },
})

/** The permission a person told needs over each kind of record (beside home.view for the bell). */
export const RECORD_VIEW: Readonly<Record<AlertRecordType, Permission>> = Object.freeze({
  QualityHold: 'quality.holds.view',
  Nonconformance: 'quality.ncr.view',
  Complaint: 'quality.complaints.view',
  Inspection: 'quality.inspections.view',
  IncomingInspection: 'quality.incoming.view',
  Certificate: 'compliance.certificates.view',
  CapaAction: 'quality.capa.view',
})

// ---- words ---------------------------------------------------------------------------------------------------------------

/** A wait in words: "at once", "45 minutes", "4 hours", "2 days" (the largest whole unit). */
export function durationWords(minutes: number, language: string): string {
  const it = language === 'it'
  if (minutes <= 0) return it ? 'subito' : 'at once'
  const unit = minutes % 1440 === 0 ? { n: minutes / 1440, one: it ? 'giorno' : 'day', many: it ? 'giorni' : 'days' } : minutes % 60 === 0 ? { n: minutes / 60, one: it ? 'ora' : 'hour', many: it ? 'ore' : 'hours' } : { n: minutes, one: it ? 'minuto' : 'minute', many: it ? 'minuti' : 'minutes' }
  return `${unit.n} ${unit.n === 1 ? unit.one : unit.many}`
}

const fill = (text: string, values: Readonly<Record<string, string>>): string => text.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all)

export interface RuleShape {
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  readonly withinMinutes: number
  readonly daysBefore: readonly number[]
  readonly channels: readonly AlertChannel[]
}

/** "When …" of a rule. */
export function whenWords(rule: Pick<RuleShape, 'event' | 'withinMinutes' | 'daysBefore'>, language: string): string {
  const facts = EVENT_FACTS[rule.event]
  const days = rule.daysBefore.join(' / ')
  const template = facts.timing === 'EVENT' && rule.withinMinutes > 0 && facts.whenWaited ? facts.whenWaited : facts.when
  return fill(wordsIn(template, language), { wait: durationWords(rule.withinMinutes, language), days })
}

/** "… tell …" of a rule: the owner, the role, or both. */
export function whoWords(rule: Pick<RuleShape, 'event' | 'audience'>, roleName: string | null, language: string): string {
  const it = language === 'it'
  const owner = EVENT_FACTS[rule.event].owner
  const ownerText = owner ? wordsIn(owner, language) : it ? 'nessuno (il record non nomina nessuno)' : 'nobody (the record names no one)'
  const roleText = roleName ? (it ? `chi ha il ruolo ${roleName}` : `everyone with the role ${roleName}`) : it ? 'un ruolo da scegliere' : 'a role to choose'
  if (rule.audience === 'OWNER') return ownerText
  if (rule.audience === 'ROLE') return roleText
  return it ? `${ownerText} e ${roleText}` : `${ownerText} and ${roleText}`
}

/** "… by …": the bell always; e-mail through the person's digest; a CAPA escalation is a task. */
export function howWords(rule: Pick<RuleShape, 'event' | 'channels'>, language: string): string {
  const it = language === 'it'
  if (EVENT_FACTS[rule.event].timing === 'ESCALATION') return it ? 'con un’attività in Le mie attività e la campanella' : 'with a task in My tasks and the bell'
  return rule.channels.includes('EMAIL') ? (it ? 'con la campanella e per e-mail nel riepilogo della persona' : "by the bell and by e-mail in the person's digest") : it ? 'con la campanella' : 'by the bell'
}

/** The rule as one sentence: "When goods are put on hold, tell the hold's owner at once, by the bell." */
export function alertRuleSentence(rule: RuleShape, roleName: string | null, language: string): string {
  const it = language === 'it'
  const facts = EVENT_FACTS[rule.event]
  const at = facts.timing === 'EVENT' && rule.withinMinutes === 0 ? (it ? ' subito' : ' at once') : ''
  return `${whenWords(rule, language)}, ${it ? 'avvisa' : 'tell'} ${whoWords(rule, roleName, language)}${at}, ${howWords(rule, language)}.`
}

/** The words of one firing for the bell ("Alert on {record}: {title}"); `test`: the rule's sentence as a test. */
export function firingTitle(input: { readonly event: QualityAlertEvent; readonly withinMinutes: number; readonly step: number; readonly date?: BusinessDate | null }, language: string): string {
  const facts = EVENT_FACTS[input.event]
  const template = facts.timing === 'EVENT' && input.withinMinutes > 0 && facts.toldWaited ? facts.toldWaited : facts.told
  return fill(wordsIn(template, language), { wait: durationWords(input.withinMinutes, language), days: String(input.step), date: input.date ? input.date.split('-').reverse().join('/') : '' })
}

export const testTitle = (sentence: string, language: string): string => (language === 'it' ? `Prova della regola qualità: ${sentence}` : `Test of the quality rule: ${sentence}`)

// ---- a rule's draft ------------------------------------------------------------------------------------------------------

export interface AlertRuleDraft {
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  readonly roleId: string | null
  readonly withinMinutes: number
  readonly daysBefore: readonly number[]
  readonly channels: readonly AlertChannel[]
}

/** Every problem of a rule at once, at its field (EXACTLY the database's guard, plus: the bell always, an owner the record names). */
export function alertRuleProblems(draft: AlertRuleDraft): Issue[] {
  const issues: Issue[] = []
  const facts = EVENT_FACTS[draft.event]
  if (!facts) return [{ path: 'event', message: 'Choose what the rule watches.' }]
  const needsRole = draft.audience === 'ROLE' || draft.audience === 'OWNER_AND_ROLE'
  if (needsRole && !draft.roleId) issues.push({ path: 'roleId', message: 'Choose the role it tells.' })
  if (!needsRole && draft.roleId) issues.push({ path: 'roleId', message: 'A rule that tells the owner alone names no role.' })
  if (draft.audience !== 'ROLE' && facts.owner === null) issues.push({ path: 'audience', message: 'A certificate names nobody: the rule tells a role.' })
  if (!Number.isInteger(draft.withinMinutes) || draft.withinMinutes < 0 || draft.withinMinutes > ALERT_LIMITS.withinMinutesMax) issues.push({ path: 'withinMinutes', message: `The wait is a whole number of minutes from 0 to ${ALERT_LIMITS.withinMinutesMax} (30 days).` })
  if (facts.timing === 'DAYS') {
    if (draft.withinMinutes !== 0) issues.push({ path: 'withinMinutes', message: 'A certificate rule fires so many days before the date, never after a wait.' })
    const days = draft.daysBefore
    if (days.length === 0 || days.length > ALERT_LIMITS.daysBeforeCount) issues.push({ path: 'daysBefore', message: `Give 1 to ${ALERT_LIMITS.daysBeforeCount} numbers of days before the date.` })
    else if (days.some((day) => !Number.isInteger(day) || day < ALERT_LIMITS.daysBeforeMin || day > ALERT_LIMITS.daysBeforeMax)) issues.push({ path: 'daysBefore', message: `Each is a whole number of days from ${ALERT_LIMITS.daysBeforeMin} to ${ALERT_LIMITS.daysBeforeMax}.` })
    else if (new Set(days).size !== days.length) issues.push({ path: 'daysBefore', message: 'Each number of days once.' })
  } else if (draft.daysBefore.length > 0) issues.push({ path: 'daysBefore', message: 'Only a certificate rule counts days before a date.' })
  if (draft.channels.length === 0 || new Set(draft.channels).size !== draft.channels.length) issues.push({ path: 'channels', message: 'Each way once, at least one.' })
  else if (!draft.channels.includes('IN_APP')) issues.push({ path: 'channels', message: "The bell is always on: e-mail reaches a person through their digest of the bell's notifications." })
  return issues
}

/** Days before, as the database keeps them: highest first. */
export const sortedDays = (days: readonly number[]): number[] => [...new Set(days)].sort((a, b) => b - a)

// ---- which rules apply ---------------------------------------------------------------------------------------------------

export interface RuleRow {
  readonly id: string
  readonly companyId: string | null
  readonly event: QualityAlertEvent
  readonly enabled: boolean
}

/**
 * The rules of an event in force for a company: its own rows when it has any (switched on or not: a company that keeps
 * its own rule switched off is told nothing by the rule of every company), else the rows of every company; the ones
 * switched on. A record with no company (a certificate of the group) takes the rules of every company.
 */
export function rulesInForce<T extends RuleRow>(rows: readonly T[], companyId: string | null, event: QualityAlertEvent): T[] {
  const ofEvent = rows.filter((row) => row.event === event)
  const own = companyId === null ? [] : ofEvent.filter((row) => row.companyId === companyId)
  return (own.length > 0 ? own : ofEvent.filter((row) => row.companyId === null)).filter((row) => row.enabled)
}

/** Whether a row is shadowed for a company: a rule of every company is not in force where the company keeps its own. */
export function shadowedFor(row: RuleRow, rows: readonly RuleRow[], companyId: string): boolean {
  return row.companyId === null && rows.some((other) => other.companyId === companyId && other.event === row.event)
}

// ---- when a firing is due ------------------------------------------------------------------------------------------------

/** The moment a record crosses a rule's wait; due when it is now or earlier and within the lookback. */
export function waitDue(since: Date, withinMinutes: number, now: Date): { due: boolean; at: Date } {
  const at = new Date(since.getTime() + withinMinutes * 60_000)
  return { due: at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= FIRING_LOOKBACK_MS, at }
}

const dayNumber = (day: BusinessDate): number => {
  const [year, month, date] = day.split('-').map(Number)
  return Math.round(Date.UTC(year!, month! - 1, date!) / 86_400_000)
}

/** Whole days from `from` to `to` (negative: before). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => dayNumber(to) - dayNumber(from)

/**
 * The step of a date rule due today: the smallest number of days before the date already reached (a new rule never tells
 * every step at once), while the date is today or later; null: none (not yet, or the date has passed).
 */
export function daysStepDue(validTo: BusinessDate, today: BusinessDate, daysBefore: readonly number[]): number | null {
  const left = daysBetween(today, validTo)
  if (left < 0) return null
  const reached = daysBefore.filter((days) => left <= days)
  return reached.length === 0 ? null : Math.min(...reached)
}

/** The key that makes a firing once: the rule, the record, the step (a wait's 0, a date step's days with the date). */
export const firingKey = (ruleId: string, recordId: string, step: number, date?: BusinessDate | null): string => `quality-alert:${ruleId}:${recordId}:${step}${date ? `:${date}` : ''}`

// ---- the starter rules (design qs-alerts) ---------------------------------------------------------------------------------

export interface StarterRule {
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  /** The role template whose system role it tells (null: the owner alone). */
  readonly roleKey: string | null
  readonly withinMinutes: number
  readonly daysBefore: readonly number[]
  readonly channels: readonly AlertChannel[]
}

/**
 * The design's rules for every company: hold placed → owner of the area · critical NCR → quality manager at once ·
 * safety complaint → owner and quality at once · inspection waiting more than 4 h → supervisor · certificate expiring →
 * compliance lead (180 / 90 / 30 days) · release waiting for the second person more than 1 h → quality manager; and the
 * CAPA escalation B-W2b-108 reads (overdue by a day → the CAPA's owner and quality). Quality is the quality inspector's
 * role (no quality-manager or compliance template exists); the supervisor is the floor supervisor's.
 */
export const STARTER_ALERT_RULES: readonly StarterRule[] = Object.freeze([
  { event: 'HOLD_PLACED', audience: 'OWNER', roleKey: null, withinMinutes: 0, daysBefore: [], channels: ['IN_APP'] },
  { event: 'CRITICAL_NCR', audience: 'ROLE', roleKey: 'quality_inspector', withinMinutes: 0, daysBefore: [], channels: ['IN_APP'] },
  { event: 'SAFETY_COMPLAINT', audience: 'OWNER_AND_ROLE', roleKey: 'quality_inspector', withinMinutes: 0, daysBefore: [], channels: ['IN_APP', 'EMAIL'] },
  { event: 'INSPECTION_WAITING', audience: 'ROLE', roleKey: 'floor_supervisor', withinMinutes: 240, daysBefore: [], channels: ['IN_APP'] },
  { event: 'CERTIFICATE_EXPIRING', audience: 'ROLE', roleKey: 'quality_inspector', withinMinutes: 0, daysBefore: [180, 90, 30], channels: ['IN_APP'] },
  { event: 'RELEASE_WAITING_SECOND_PERSON', audience: 'ROLE', roleKey: 'quality_inspector', withinMinutes: 60, daysBefore: [], channels: ['IN_APP'] },
  { event: 'CAPA_ACTION_OVERDUE', audience: 'OWNER_AND_ROLE', roleKey: 'quality_inspector', withinMinutes: 1440, daysBefore: [], channels: ['IN_APP'] },
])

/** The starter rules whose event has no rule of every company yet. */
export const missingStarterRules = (tenantWideEvents: ReadonlySet<string>): StarterRule[] => STARTER_ALERT_RULES.filter((rule) => !tenantWideEvents.has(rule.event))

/** The changes the rules' event names (quality.alert_rule_changed). */
export const ALERT_RULE_CHANGES = ['CREATED', 'EDITED', 'REMOVED', 'STARTER_ADDED'] as const
export type AlertRuleChange = (typeof ALERT_RULE_CHANGES)[number]
