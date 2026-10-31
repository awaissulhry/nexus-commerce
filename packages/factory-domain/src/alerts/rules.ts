import type { BusinessDate } from '../core/time'
import { ALERT_CHANNELS, KINDS, thresholdOf, type AlertChannel, type AlertSeverity, type RuleKind, type Words } from './kinds'

/**
 * Stored alerts and how a rule's evaluation turns into them (B-W2a-33; ANA-036; design home.alerts "Open alerts" with the
 * popup alert, "Rules" with the popup rule), pure. apps/factory-api platform/alerts applies them; the database
 * (alerts.prisma, …_platform_w2a_guards) holds the same shape:
 *
 *   an alert   ONE firing of a rule for one record: born OPEN with nothing done; OPEN → ACKNOWLEDGED → RESOLVED, or
 *              OPEN → RESOLVED; resolved, it changes no more. Assigned (to an office person who may handle it), snoozed
 *              (off the lists until a time, at most 30 days), resolved by a person WITH A NOTE saying what was done
 *              (HANDLED), or by the system when the condition no longer holds (CLEARED). Every one of those is in its
 *              history (AlertEvent, append-only), with the same actor and time.
 *   its key    `<kind>:<record id>`: one unresolved alert per kind and record, whichever rule of the kind raised it
 *              (two rules of a kind that both find a record raise ONE alert: the most specific rule's, a site's before a
 *              company's before the tenant's). The next one after a resolution is a new alert (occurrence + 1), and only
 *              when the rule's cooldown has passed since the last one was raised (at most once per cooldown per record).
 *
 * Nobody is counted: the lists filter by "assigned to me" and "unassigned", never by another person, and no total per
 * person exists (Statuto dei Lavoratori art. 4; Owner answer W1). An alert's facts carry no money.
 */

export const ALERT_STATES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const
export type AlertState = (typeof ALERT_STATES)[number]
export const ALERT_RESOLUTIONS = ['HANDLED', 'CLEARED'] as const
export type AlertResolution = (typeof ALERT_RESOLUTIONS)[number]

/** The tiles of home.alerts ("Open for me · Critical · Unassigned · Acknowledged · Resolved today"): saved filters. */
export const ALERT_TILES = ['OPEN_FOR_ME', 'CRITICAL', 'UNASSIGNED', 'ACKNOWLEDGED', 'RESOLVED_TODAY'] as const
export type AlertTile = (typeof ALERT_TILES)[number]

/** What a person may do with an alert (the popup's buttons). */
export const ALERT_VERBS = ['ACKNOWLEDGE', 'ASSIGN', 'SNOOZE', 'RESOLVE'] as const
export type AlertVerb = (typeof ALERT_VERBS)[number]

/** A snooze lasts at most this long. */
export const SNOOZE_MAX_DAYS = 30
export const NOTE_MAX = 1000
/** The most alerts one bulk acknowledge takes. */
export const BULK_MAX = 200

export const ALERT_REFUSALS = {
  RESOLVED: 'This alert is resolved: it changes no more.',
  ALREADY_ACKNOWLEDGED: 'This alert is acknowledged already.',
  ALREADY_ASSIGNED: 'This alert is assigned to this person already.',
  NOT_ASSIGNED: 'This alert is not assigned to anyone.',
} as const
export type AlertRefusal = keyof typeof ALERT_REFUSALS

export const RULE_REFUSALS = {
  BUILT_IN_KIND: 'A built-in rule keeps its kind; add a rule to watch something else.',
  NO_BELL: 'An alert rule tells through the bell (IN_APP): e-mail alone is not sent before the notification preferences (W2b); people get alerts by e-mail only in the daily digest they turn on.',
  SITE_NEEDS_COMPANY: 'A site is named only with its company.',
} as const
export type RuleRefusal = keyof typeof RULE_REFUSALS

export const isResolved = (alert: { readonly state: string }): boolean => alert.state === 'RESOLVED'
export const isSnoozedNow = (alert: { readonly snoozedUntil: Date | null }, now: Date): boolean => alert.snoozedUntil !== null && alert.snoozedUntil.getTime() > now.getTime()

/** Why a snooze time is refused, or null: it must be later than now and at most 30 days ahead. */
export function snoozeProblem(until: Date, now: Date): string | null {
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return 'Snooze until a time later than now.'
  if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * 86_400_000) return `Snooze for at most ${SNOOZE_MAX_DAYS} days.`
  return null
}

/** A resolution's note, trimmed, or the problem: it says what was done. */
export function resolveNote(note: string): { readonly note: string } | { readonly problem: string } {
  const text = note.trim()
  if (text === '') return { problem: 'Say what was done: a resolution needs a note.' }
  if (text.length > NOTE_MAX) return { problem: `A note has at most ${NOTE_MAX} characters.` }
  return { note: text }
}

/** The verbs a person who may handle the alert has now (none on a resolved one). */
export function verbsOf(alert: { readonly state: string }, mayHandle: boolean): AlertVerb[] {
  if (!mayHandle || isResolved(alert)) return []
  return alert.state === 'OPEN' ? ['ACKNOWLEDGE', 'ASSIGN', 'SNOOZE', 'RESOLVE'] : ['ASSIGN', 'SNOOZE', 'RESOLVE']
}

export const dedupeKeyOf = (kind: string, recordId: string, subKey?: string | null): string => `${kind}:${recordId}${subKey ? `:${subKey}` : ''}`


// ---- whom an alert is for -------------------------------------------------------------------------------------------------

/** A record's place, as an alert keeps it. */
export interface AlertScope {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
}

/** A live role assignment, as the API reads it (platform/auth/roles heldRoles). */
export interface HeldRole {
  readonly roleId: string
  readonly scope: { readonly allCompanies: boolean; readonly companyIds: readonly string[]; readonly siteIds: readonly string[]; readonly partyIds: readonly string[] }
}

/** Whether this assignment of the role reaches the record's place (its company, site and party; empty sets: all of them). */
export function roleReaches(held: HeldRole, scope: AlertScope): boolean {
  const { allCompanies, companyIds, siteIds, partyIds } = held.scope
  if (scope.companyId !== null && !allCompanies && !companyIds.includes(scope.companyId)) return false
  if (scope.siteId !== null && siteIds.length > 0 && !siteIds.includes(scope.siteId)) return false
  if (scope.partyId !== null && partyIds.length > 0 && !partyIds.includes(scope.partyId)) return false
  return true
}

/** Whether a person is among a rule's recipients for this place: they hold its role there. A rule without a role tells nobody by role. */
export const isRecipient = (held: readonly HeldRole[], recipientRoleId: string | null, scope: AlertScope): boolean =>
  recipientRoleId !== null && held.some((role) => role.roleId === recipientRoleId && roleReaches(role, scope))

/**
 * "Open for me": unresolved, not snoozed now, and mine: assigned to me, or nobody's yet and its rule tells me (I hold its
 * recipient role at the record's place).
 */
export function isForMe(alert: { readonly state: string; readonly snoozedUntil: Date | null; readonly assignedToId: string | null }, me: string, recipient: boolean, now: Date): boolean {
  if (isResolved(alert) || isSnoozedNow(alert, now)) return false
  return alert.assignedToId === me || (alert.assignedToId === null && recipient)
}

// ---- a rule's place ----------------------------------------------------------------------------------------------------------

export interface RulePlace {
  readonly companyId: string | null
  readonly siteId: string | null
}

/**
 * Whether a rule's place covers a record: no company = everywhere; a company = its records (a record of no company, such
 * as a shared certificate, belongs to every company); a site = that site's records, and its company's records of no site
 * (an order, an invoice: they belong to the company).
 */
export function placeCovers(rule: RulePlace, scope: Pick<AlertScope, 'companyId' | 'siteId'>): boolean {
  if (rule.companyId !== null && scope.companyId !== null && scope.companyId !== rule.companyId) return false
  if (rule.siteId !== null && scope.siteId !== null && scope.siteId !== rule.siteId) return false
  return true
}

/** How specific a place is: a site 2, a company 1, everywhere 0. */
export const specificity = (rule: RulePlace): number => (rule.siteId !== null ? 2 : rule.companyId !== null ? 1 : 0)

// ---- an evaluation -------------------------------------------------------------------------------------------------------------

/** A record a rule's evaluation found (what the evaluator of its kind returned for that rule's numbers and place). */
export interface Finding {
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly scope: AlertScope
  readonly subKey?: string | null
  /** Why: the numbers it fired on and what was found (no money; dates as YYYY-MM-DD). */
  readonly facts: Readonly<Record<string, string | number | boolean | null>>
}

/** An enabled rule of the kind, as the evaluation sees it. */
export interface EvaluatedRule extends RulePlace {
  readonly id: string
  readonly severity: AlertSeverity
  readonly cooldownMinutes: number
  readonly createdAt: Date
}

/** An alert of the kind as stored (the key's latest occurrence, resolved or not). */
export interface KeyState {
  readonly alertId: string
  readonly dedupeKey: string
  readonly recordId: string
  readonly occurrence: number
  readonly raisedAt: Date
  readonly resolved: boolean
}

export interface RaisePlan {
  readonly rule: EvaluatedRule
  readonly finding: Finding
  readonly dedupeKey: string
  readonly occurrence: number
}

export interface EvaluationPlan {
  /** New alerts (no unresolved one of the key, and the rule's cooldown passed since the key's last one). */
  readonly raise: readonly RaisePlan[]
  /** Unresolved alerts the system resolves: no enabled rule of the kind finds their record now. */
  readonly clear: readonly string[]
  /** Found again while an alert of the key is unresolved: nothing to do. */
  readonly kept: number
  /** Found, but the key's last alert was raised within the cooldown: not raised again yet. */
  readonly cooling: number
}

/** The rule that raises a record found by several rules of a kind: the most specific place, then the oldest rule. */
function winner(rules: readonly EvaluatedRule[]): EvaluatedRule {
  return [...rules].sort((a, b) => specificity(b) - specificity(a) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))[0]!
}

/**
 * One evaluation of a kind: each enabled rule's findings (already for its numbers and place), the latest alert of each
 * key, and whether this pass may raise (a DATE kind's pass only clears: its alerts are raised by their timers). `only`:
 * the records this pass looked at (a recheck after an event); alerts of other records are left alone.
 */
export function planEvaluation(input: {
  readonly kind: string
  readonly findings: ReadonlyMap<string, readonly Finding[]>
  readonly rules: readonly EvaluatedRule[]
  readonly latest: readonly KeyState[]
  readonly now: Date
  readonly raise: boolean
  readonly only?: ReadonlySet<string> | undefined
}): EvaluationPlan {
  const byKey = new Map<string, { finding: Finding; rules: EvaluatedRule[] }>()
  for (const rule of input.rules) {
    for (const finding of input.findings.get(rule.id) ?? []) {
      if (input.only && !input.only.has(finding.recordId)) continue
      const key = dedupeKeyOf(input.kind, finding.recordId, finding.subKey)
      const entry = byKey.get(key) ?? { finding, rules: [] }
      entry.rules.push(rule)
      byKey.set(key, entry)
    }
  }
  const latest = new Map(input.latest.map((state) => [state.dedupeKey, state]))
  const raise: RaisePlan[] = []
  let kept = 0
  let cooling = 0
  if (input.raise) {
    for (const [dedupeKey, { finding, rules }] of [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const last = latest.get(dedupeKey)
      if (last && !last.resolved) {
        kept++
        continue
      }
      const rule = winner(rules)
      if (last && input.now.getTime() - last.raisedAt.getTime() < rule.cooldownMinutes * 60_000) {
        cooling++
        continue
      }
      raise.push({ rule, finding, dedupeKey, occurrence: (last?.occurrence ?? 0) + 1 })
    }
  } else {
    kept = [...byKey.keys()].filter((key) => latest.get(key)?.resolved === false).length
  }
  const clear = input.latest
    .filter((state) => !state.resolved && !byKey.has(state.dedupeKey) && (!input.only || input.only.has(state.recordId)))
    .map((state) => state.alertId)
    .sort()
  return { raise, clear, kept, cooling }
}

// ---- words ---------------------------------------------------------------------------------------------------------------

export type Locale = 'en' | 'it'
const pick = (words: Words, locale: Locale): string => words[locale]

/** How often at most, in words: 0 → every time it is found; 60 → at most once an hour; 1440 → at most once a day. */
export function cooldownWords(minutes: number, locale: Locale = 'en'): string {
  const it = locale === 'it'
  if (minutes <= 0) return it ? 'ogni volta che lo trova' : 'every time it is found'
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? (it ? 'al massimo una volta al giorno' : 'at most once a day') : it ? `al massimo una volta ogni ${days} giorni` : `at most once every ${days} days`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? (it ? "al massimo una volta all'ora" : 'at most once an hour') : it ? `al massimo una volta ogni ${hours} ore` : `at most once every ${hours} hours`
  }
  return it ? `al massimo una volta ogni ${minutes} minuti` : `at most once every ${minutes} minutes`
}

const CHANNEL_WORDS: Readonly<Record<AlertChannel, Words>> = Object.freeze({ IN_APP: { en: 'the bell', it: 'la campanella' }, EMAIL: { en: 'e-mail', it: 'e-mail' } })
export const channelsWords = (channels: readonly AlertChannel[], locale: Locale = 'en'): string =>
  ALERT_CHANNELS.filter((channel) => channels.includes(channel))
    .map((channel) => pick(CHANNEL_WORDS[channel], locale))
    .join(locale === 'it' ? ' e ' : ' and ')

/** The "when" of a rule's sentence, from its numbers. */
function whenWords(kind: RuleKind, threshold: Record<string, number | boolean>, locale: Locale): string {
  const it = locale === 'it'
  const n = (key: string): number => Number(threshold[key] ?? 0)
  const working = threshold.workingDays === true
  const days = (count: number) => (it ? `${count} ${working ? 'giorni lavorativi' : count === 1 ? 'giorno' : 'giorni'}` : `${count} ${working ? 'working ' : ''}day${count === 1 ? '' : 's'}`)
  switch (kind) {
    case 'ORDER_LATE_RISK':
      return it ? `Quando un ordine è promesso entro ${days(n('daysBeforePromise'))} e non è pronto, o è in ritardo` : `When an order is promised within ${days(n('daysBeforePromise'))} and is not ready, or is late`
    case 'HOLD_TOO_LONG':
      return it ? `Quando qualcosa resta bloccato più di ${n('hours')} h` : `When goods are on hold longer than ${n('hours')} h`
    case 'MATERIAL_SHORT':
      return it ? 'Quando manca materiale per un ordine di lavoro rilasciato' : 'When material is short for a released work order'
    case 'APPROVAL_OVERDUE':
      return it ? `Quando un'approvazione aspetta più di ${n('hours')} h` : `When an approval waits longer than ${n('hours')} h`
    case 'PO_NOT_CONFIRMED':
      // B-W2a-69: the order's confirm-by time; the days only for an order sent without one.
      return it
        ? `Quando un ordine di acquisto non è confermato entro l'ora chiesta al fornitore (senza un'ora: ${days(n('days'))} dopo l'invio)`
        : `When a purchase order is not confirmed by the time the supplier was asked to answer by (none asked: ${days(n('days'))} after it was sent)`
    case 'CERTIFICATE_EXPIRING':
      return it ? `${days(n('daysBefore'))} prima che un certificato scada` : `${days(n('daysBefore'))} before a certificate expires`
    case 'INVOICE_DEADLINE':
      return it ? `${days(n('daysBefore'))} prima della scadenza per fatturare la merce di un DDT` : `${days(n('daysBefore'))} before the deadline to invoice a DDT's goods`
    case 'INTEGRATION_FAILING':
      return it ? `Quando un collegamento non funziona da più di ${n('hours')} h` : `When a connection has not worked for more than ${n('hours')} h`
  }
}

/**
 * A rule as one sentence (design RuleSentence: "When a lot is on hold longer than [24 h] at [Plant 1], tell [Quality] by
 * [bell] at most [once a day]."), with the place's and the role's names as the API read them.
 */
export function ruleSentence(
  rule: { readonly ruleKind: RuleKind; readonly threshold: unknown; readonly channels: readonly AlertChannel[]; readonly cooldownMinutes: number },
  names: { readonly place: string | null; readonly recipient: string | null },
  locale: Locale = 'en',
): string {
  const it = locale === 'it'
  const when = whenWords(rule.ruleKind, thresholdOf(rule.ruleKind, rule.threshold), locale)
  const where = names.place ? (it ? ` a ${names.place}` : ` at ${names.place}`) : ''
  const whom = names.recipient ? (it ? `avvisa ${names.recipient}` : `tell ${names.recipient}`) : it ? 'non avvisa nessuno per ruolo' : 'tell nobody by role'
  return `${when}${where}, ${whom} ${it ? 'con' : 'by'} ${channelsWords(rule.channels, locale)} ${cooldownWords(rule.cooldownMinutes, locale)}.`
}

/** The kind's label in words. */
export const kindLabel = (kind: RuleKind, locale: Locale = 'en'): string => pick(KINDS[kind].label, locale)

// ---- an alert's sentence ---------------------------------------------------------------------------------------------------

/**
 * Every alert sentence, per kind and variant, in English and Italian (a phrase: its key and params; the web may draw the
 * same keys from its own catalogue). Params: {label} the record's label, numbers and dates (YYYY-MM-DD) from the facts.
 */
export const ALERT_TEMPLATES = {
  'alerts.ORDER_LATE_RISK.LATE': { en: 'Order {label} is {days} days late: it was promised for {promiseDate}.', it: "L'ordine {label} è in ritardo di {days} giorni: era promesso per il {promiseDate}." },
  'alerts.ORDER_LATE_RISK.AT_RISK': { en: 'Order {label} is promised for {promiseDate} ({days} days left) and is not ready.', it: "L'ordine {label} è promesso per il {promiseDate} (mancano {days} giorni) e non è pronto." },
  'alerts.HOLD_TOO_LONG': { en: '{label} has been on hold for {hours} hours (the rule says {threshold} h).', it: '{label} è bloccato da {hours} ore (la regola dice {threshold} h).' },
  'alerts.MATERIAL_SHORT': { en: 'Material {item} is short for released work order {label}.', it: "Il materiale {item} manca per l'ordine di lavoro rilasciato {label}." },
  'alerts.APPROVAL_OVERDUE': { en: 'Quote {label} has waited {hours} hours for its approval.', it: 'Il preventivo {label} aspetta la sua approvazione da {hours} ore.' },
  'alerts.PO_NOT_CONFIRMED': { en: 'Purchase order {label} is not confirmed {days} days after it was sent.', it: "L'ordine di acquisto {label} non è confermato {days} giorni dopo l'invio." },
  'alerts.CERTIFICATE_EXPIRING': { en: 'Certificate {label} expires on {dueDate} ({days} days left).', it: 'Il certificato {label} scade il {dueDate} (mancano {days} giorni).' },
  'alerts.INVOICE_DEADLINE': { en: 'The goods of DDT {label} must be invoiced by {dueDate} ({days} days left).', it: 'La merce del DDT {label} va fatturata entro il {dueDate} (mancano {days} giorni).' },
  // B-W2b-24: a connection failing ({label} its name; {hours} since its last success, or since it was set up when none worked).
  'alerts.INTEGRATION_FAILING': { en: 'Connection {label} has not worked for {hours} hours: its last call failed.', it: 'Il collegamento {label} non funziona da {hours} ore: la sua ultima chiamata non è riuscita.' },
  'alerts.INTEGRATION_FAILING.NEVER': { en: 'Connection {label} has never worked: no call has succeeded in the {hours} hours since it was set up.', it: 'Il collegamento {label} non ha mai funzionato: nessuna chiamata è riuscita nelle {hours} ore da quando è stato impostato.' },
  'alerts.INVOICE_DEADLINE.LATE': { en: 'The goods of DDT {label} were due to be invoiced by {dueDate}: {days} days late.', it: 'La merce del DDT {label} andava fatturata entro il {dueDate}: {days} giorni di ritardo.' },
} as const satisfies Record<string, Words>
export type AlertTemplateKey = keyof typeof ALERT_TEMPLATES

export interface AlertPhrase {
  readonly key: AlertTemplateKey
  readonly params: Readonly<Record<string, string | number>>
}

const dateWords = (value: string, locale: Locale): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? (locale === 'it' ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value) : value)

/** The phrase of an alert from its kind, label and facts (as raised). */
export function alertPhrase(kind: string, label: string, facts: unknown): AlertPhrase | null {
  const f = (facts && typeof facts === 'object' ? facts : {}) as Record<string, unknown>
  const num = (key: string): number => (typeof f[key] === 'number' ? (f[key] as number) : 0)
  const text = (key: string): string => (typeof f[key] === 'string' ? (f[key] as string) : '')
  switch (kind) {
    case 'ORDER_LATE_RISK':
      return f.late === true
        ? { key: 'alerts.ORDER_LATE_RISK.LATE', params: { label, days: Math.abs(num('daysLeft')), promiseDate: text('promiseDate') } }
        : { key: 'alerts.ORDER_LATE_RISK.AT_RISK', params: { label, days: num('daysLeft'), promiseDate: text('promiseDate') } }
    case 'HOLD_TOO_LONG':
      return { key: 'alerts.HOLD_TOO_LONG', params: { label, hours: num('hours'), threshold: num('threshold') } }
    case 'MATERIAL_SHORT':
      return { key: 'alerts.MATERIAL_SHORT', params: { label, item: text('item') } }
    case 'APPROVAL_OVERDUE':
      return { key: 'alerts.APPROVAL_OVERDUE', params: { label, hours: num('hours') } }
    case 'PO_NOT_CONFIRMED':
      return { key: 'alerts.PO_NOT_CONFIRMED', params: { label, days: num('days') } }
    case 'CERTIFICATE_EXPIRING':
      return { key: 'alerts.CERTIFICATE_EXPIRING', params: { label, dueDate: text('dueDate'), days: num('daysLeft') } }
    case 'INVOICE_DEADLINE':
      return num('daysLeft') < 0
        ? { key: 'alerts.INVOICE_DEADLINE.LATE', params: { label, dueDate: text('dueDate'), days: Math.abs(num('daysLeft')) } }
        : { key: 'alerts.INVOICE_DEADLINE', params: { label, dueDate: text('dueDate'), days: num('daysLeft') } }
    case 'INTEGRATION_FAILING':
      return { key: f.never === true ? 'alerts.INTEGRATION_FAILING.NEVER' : 'alerts.INTEGRATION_FAILING', params: { label, hours: num('hours') } }
    default:
      return null
  }
}

/** A phrase in a language (an unknown kind: "Alert on {label}"). */
export function phraseText(phrase: AlertPhrase | null, label: string, locale: Locale = 'en'): string {
  if (phrase === null) return locale === 'it' ? `Avviso su ${label}.` : `Alert on ${label}.`
  return ALERT_TEMPLATES[phrase.key][locale].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = phrase.params[name]
    if (value === undefined) return whole
    return typeof value === 'string' ? dateWords(value, locale) : String(value)
  })
}

/** Days from a business date to another (negative: earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const at = (date: BusinessDate) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  return Math.round((at(to) - at(from)) / 86_400_000)
}
