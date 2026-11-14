import type { Grain } from '../auth/grains/grains'
import type { Issue } from '../core/errors'
import { fromMinorUnits, minorPlaces } from '../core/money'
import { isMarkedJson } from '../money/marked'
import { Dec } from '../tax/decimal'

/**
 * The notification centre's rules (B-W2a-20; PLT-138 in-app notification centre, PLT-142 quiet defaults, PLT-152 text
 * per reader; design home.notifications, shell.frame bell), pure. apps/factory-api platform/notifications applies them;
 * the database (collab.prisma, …_platform_w2a_guards) keeps a notification's words, record and event fixed and lets its
 * person only read, finish and snooze it.
 *
 * QUIET BY DEFAULT (PLT-142; design "only mentions, assignments, approvals and records I own or follow; everything else is
 * opt-in"): the fan-out makes a notification only for
 *   MENTION      someone @mentioned the person in a note;
 *   ASSIGNMENT   something was given to the person (a task, a row of Today);
 *   APPROVAL     an approval waits for the person, was decided for them, or its asker nudged them;
 *   ALERT        an alert rule names the person (B-W2a-33's rules add theirs);
 *   FOLLOWING    a message entered the thread of a record the person follows (and did not mute);
 *   SYSTEM       the system finished something the person asked for (an export, B-W2a-23).
 * Nothing is e-mailed unless the person turned on their daily digest (off by default): no instant e-mail exists before the
 * preferences matrix (W2b). Nothing in a notification counts other people (Statuto dei Lavoratori art. 4; Owner W1).
 *
 * TEXT PER READER (PLT-152): a notification keeps a message key and params made FOR its reader at fan-out: an amount is
 * in its params only when the reader held its grain then, marked with it (markMoney), so the API's grain filter drops it
 * again for a reader who lost the grain. People are user ids; their names are read when shown.
 */

export const NOTIFICATION_CATEGORIES = ['MENTION', 'ASSIGNMENT', 'APPROVAL', 'ALERT', 'FOLLOWING', 'SYSTEM'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** The tabs of home.notifications ("All · Mentions · Assigned to me · Approvals · System"). */
export const NOTIFICATION_TABS = ['ALL', 'MENTION', 'ASSIGNMENT', 'APPROVAL', 'SYSTEM'] as const
export type NotificationTab = (typeof NOTIFICATION_TABS)[number]

/** The categories each tab shows: "System" is what the system told me (alerts, finished jobs); news of a followed record is in All. */
export const TAB_CATEGORIES: Readonly<Record<NotificationTab, readonly NotificationCategory[]>> = Object.freeze({
  ALL: NOTIFICATION_CATEGORIES,
  MENTION: ['MENTION'],
  ASSIGNMENT: ['ASSIGNMENT'],
  APPROVAL: ['APPROVAL'],
  SYSTEM: ['SYSTEM', 'ALERT'],
})

/** Which notifications a list shows: still to look at (not done, not snoozed now), done, or snoozed. */
export const NOTIFICATION_STATES = ['OPEN', 'DONE', 'SNOOZED'] as const
export type NotificationState = (typeof NOTIFICATION_STATES)[number]

// ---- the sentences ------------------------------------------------------------------------------------------------------

/**
 * Every message key a notification may carry, with its sentence in English and Italian (the e-mail digest draws them;
 * the web draws the same keys from its own catalogue). Placeholders: {actor} the person who caused it (a user id in
 * `actorId`), {record} the record's label, {title} a task's title, {kind} a Today row's kind in words, {status} a
 * decision, {figure} the amount the reader may see (only when params hold one); B-W2b-385: {count}, {entered}, {left} the
 * rows of a followed saved view (numbers in params).
 */
export const MESSAGE_TEMPLATES = {
  'notifications.mentioned': { en: '{actor} mentioned you on {record}', it: '{actor} ti ha menzionato su {record}' },
  'notifications.following.note': { en: '{actor} wrote a note on {record}, which you follow', it: '{actor} ha scritto una nota su {record}, che segui' },
  'notifications.following.mail_in': { en: 'A reply arrived on {record}, which you follow', it: 'È arrivata una risposta su {record}, che segui' },
  'notifications.following.mail_out': { en: '{actor} sent a message on {record}, which you follow', it: '{actor} ha inviato un messaggio su {record}, che segui' },
  'notifications.assigned.today': { en: '{actor} assigned you {record} on Today ({kind})', it: '{actor} ti ha assegnato {record} su Oggi ({kind})' },
  'notifications.assigned.task': { en: '{actor} assigned you the task "{title}" ({record})', it: '{actor} ti ha assegnato l’attività "{title}" ({record})' },
  'notifications.approval.quote_requested': { en: '{actor} asks you to approve quote {record}{figure}', it: '{actor} ti chiede di approvare il preventivo {record}{figure}' },
  'notifications.approval.quote_decided': { en: '{actor} {status} your approval request for quote {record}', it: '{actor} ha {status} la tua richiesta di approvazione del preventivo {record}' },
  'notifications.approval.nudged': { en: '{actor} reminds you: quote {record} still waits for your approval', it: '{actor} ti ricorda: il preventivo {record} aspetta ancora la tua approvazione' },
  // B-W2a-35 (modules/plant): a machine problem reported (to who triages it), an unsafe one, a job given to a technician.
  'notifications.plant.reported': { en: 'A machine problem was reported on {record}: {title}', it: 'Segnalato un problema sulla macchina {record}: {title}' },
  'notifications.plant.unsafe': { en: '{record} was marked unsafe ({title}): it stays do-not-use until a technician signs it safe', it: '{record} è stata segnalata non sicura ({title}): resta fuori uso finché un tecnico non la dichiara sicura' },
  // B-W2b-96: a machine request routed to the person (their team or themselves), escalated to them (nobody acknowledged it).
  'notifications.plant.routed': { en: 'A machine problem on {record} was sent to you: {title}', it: 'Un problema sulla macchina {record} è stato inviato a te: {title}' },
  'notifications.plant.escalated': { en: 'Nobody has acknowledged the machine problem on {record} yet: {title}', it: 'Nessuno ha ancora preso in carico il problema sulla macchina {record}: {title}' },
  'notifications.assigned.job': { en: '{actor} assigned you maintenance job {record}: "{title}"', it: '{actor} ti ha assegnato l’intervento {record}: "{title}"' },
  // B-W2a-33: an exception rule raised an alert for a record (ALERT; {title} the rule's name), an alert was given to the person.
  'notifications.alert.raised': { en: 'Alert on {record}: {title}', it: 'Avviso su {record}: {title}' },
  'notifications.assigned.alert': { en: '{actor} assigned you the alert "{title}" on {record}', it: '{actor} ti ha assegnato l’avviso "{title}" su {record}' },
  // B-W2a-65: a complaint was found to be about safety ({title}: the customer's first words): the owner and quality, at once.
  // B-W2b-24 (platform/timers/restore-drill.ts): the next restore drill is due within 14 days ({record}: the last drill that passed).
  'notifications.security.drillDue': { en: 'The next restore drill is due on {title}: the last one that passed was on {record}', it: 'La prossima prova di ripristino scade il {title}: l’ultima superata è del {record}' },
  // B-W2b-35 (modules/production/calls): a station called for help, told to the type's responder team ({record}: the station; {title}: the type and the line).
  'notifications.calls.raised': { en: 'Help call from station {record}: {title}', it: 'Chiamata di aiuto dalla postazione {record}: {title}' },
  // B-W2b-125 (modules/safety/incidents/notices.ts): a new incident report to the safety roles ({title}: the kind), an INAIL
  // filing's reminder before its 48-hour deadline and at it ({title}: the deadline, Europe/Rome). Never the person.
  'notifications.safety.incidentReported': { en: 'New report {record}: {title}', it: 'Nuova segnalazione {record}: {title}' },
  'notifications.safety.inailDue': { en: 'INAIL report for {record} due by {title}', it: 'Comunicazione INAIL per {record} da inviare entro {title}' },
  'notifications.safety.inailLate': { en: 'INAIL report for {record} is late: it was due by {title}', it: 'Comunicazione INAIL per {record} in ritardo: era da inviare entro {title}' },
  // B-W2b-177 (platform/files/expiry/notices.ts): a document of a record stops being valid soon, 30 then 7 days before
  // ({kind}: the file's name; {title}: the expiry date, Europe/Rome), to the record's owner and its followers.
  'notifications.files.expiryDue': { en: '{kind} on {record} expires on {title}', it: '{kind} su {record} scade il {title}' },
  // B-W2b-F17 (platform/links/notices.ts): the holder of a dead link with no renewer asked for a new one, told to the person
  // who made the link (SYSTEM), with the reader's note as {title} when they wrote one. No new link was made.
  'notifications.links.renewAsked': { en: 'The link you sent for {record} no longer opens: its holder asks for a new one', it: 'Il link che hai mandato per {record} non si apre più: chi lo ha ricevuto ne chiede uno nuovo' },
  'notifications.links.renewAskedNote': { en: 'The link you sent for {record} no longer opens: its holder asks for a new one ("{title}")', it: 'Il link che hai mandato per {record} non si apre più: chi lo ha ricevuto ne chiede uno nuovo ("{title}")' },
  // B-W2b-226 (modules/product/changes/notices.ts): a new change request to who triages it and the style's owner ({title}: the
  // style and what should change), its decision to who raised it ({title}: why, for a rejection), a change order's approval
  // asked of its approvers and decided for its author, its release to its followers, the style's owner and the supervisors of
  // the work orders it decides for ({kind}: their numbers).
  'notifications.changes.requestRaised': { en: 'New change request {record}: {title}', it: 'Nuova richiesta di modifica {record}: {title}' },
  'notifications.changes.requestAccepted': { en: '{actor} accepted your change request {record}', it: '{actor} ha accettato la tua richiesta di modifica {record}' },
  'notifications.changes.requestRejected': { en: '{actor} rejected your change request {record}: {title}', it: '{actor} ha rifiutato la tua richiesta di modifica {record}: {title}' },
  'notifications.changes.approvalAsked': { en: '{actor} asks you to approve change order {record}: {title}', it: '{actor} ti chiede di approvare l’ordine di modifica {record}: {title}' },
  'notifications.changes.orderDecided': { en: '{actor} {status} change order {record}', it: '{actor} ha {status} l’ordine di modifica {record}' },
  'notifications.changes.orderReleased': { en: 'Change order {record} was released: {title}', it: 'L’ordine di modifica {record} è stato rilasciato: {title}' },
  'notifications.changes.workInProgress': { en: 'Change order {record} was released: {title}. It decides what happens to work orders {kind}', it: 'L’ordine di modifica {record} è stato rilasciato: {title}. Decide cosa succede agli ordini di lavoro {kind}' },
  // B-W2b-307: the approval engine's requests (to their deciders; the decision to who asked) and an SMV change to its approvers.
  'notifications.approval.taskAsked': { en: '{actor} asks for your yes on {record}: {title}', it: '{actor} chiede il tuo sì su {record}: {title}' },
  'notifications.approval.taskDecided': { en: '{actor} {status} your request on {record}: {title}', it: '{actor} ha {status} la tua richiesta su {record}: {title}' },
  'notifications.approval.smvAsked': { en: '{actor} asks you to approve an SMV change of operation {record}: {title}', it: '{actor} ti chiede di approvare una modifica del tempo standard dell’operazione {record}: {title}' },
  'notifications.complaint.safety': { en: 'Safety complaint {record}: {title}. It is in the PPE register; the owner acknowledges it on the complaint', it: 'Reclamo di sicurezza {record}: {title}. È nel registro DPI; il titolare ne prende atto sul reclamo' },
  // B-W2b-385 (PLT-151): a saved view the person follows changed ({record}: the view's name; {count} rows now, {entered} came in,
  // {left} left; without the last ids only how many now), and a record the person follows moved (its status or stage).
  'notifications.following.view': { en: '{record}, a saved view you follow, changed: {entered} came in, {left} left ({count} now)', it: '{record}, una vista salvata che segui, è cambiata: {entered} entrati, {left} usciti (ora {count})' },
  'notifications.following.viewCount': { en: '{record}, a saved view you follow, changed ({count} now)', it: '{record}, una vista salvata che segui, è cambiata (ora {count})' },
  'notifications.following.changed': { en: '{record}, which you follow, changed', it: '{record}, che segui, è cambiato' },
  // B-W2b-385 (NT1:01-03): a request to buy put on a purchase order ({title}: the order's number) or refused by the buyer, to who
  // asked; an inquiry given to a person; a product-safety report to the people who assess them (with an accident: said).
  'notifications.purchasing.requestOrdered': { en: 'Your request to buy {record} was put on purchase order {title}', it: 'La tua richiesta di acquisto {record} è stata messa nell’ordine di acquisto {title}' },
  'notifications.purchasing.requestRefused': { en: '{actor} refused your request to buy {record}', it: '{actor} ha rifiutato la tua richiesta di acquisto {record}' },
  'notifications.inquiries.assigned': { en: '{actor} gave you inquiry {record}', it: '{actor} ti ha affidato la richiesta {record}' },
  'notifications.safety.productReport': { en: 'Product-safety report {record} came in: assess it', it: 'È arrivata la segnalazione di sicurezza {record}: valutala' },
  'notifications.safety.productAccident': { en: 'Product-safety report {record} came in with an accident: assess it and see whether the authority must be told', it: 'È arrivata la segnalazione di sicurezza {record} con un incidente: valutala e verifica se va informata l’autorità' },
  // B-W2b-398 (LOG-063): a tracking problem on a shipment on its way, to the dispatch desk of its site ({record}: the shipment).
  'notifications.shipping.delayed': { en: 'Shipment {record} is late: check it with the carrier', it: 'La spedizione {record} è in ritardo: verificala con il vettore' },
  'notifications.shipping.addressProblem': { en: 'The carrier cannot deliver shipment {record} to its address: check it with the customer', it: 'Il vettore non riesce a consegnare la spedizione {record} all’indirizzo: verificalo con il cliente' },
  'notifications.shipping.failedDelivery': { en: 'The carrier failed to deliver shipment {record}: arrange a new delivery', it: 'Il vettore non è riuscito a consegnare la spedizione {record}: organizza una nuova consegna' },
  'notifications.shipping.noScan': { en: 'No carrier news on shipment {record} for days: ask the carrier', it: 'Nessuna notizia dal vettore sulla spedizione {record} da giorni: chiedi al vettore' },
} as const satisfies Record<string, { readonly en: string; readonly it: string }>
export type MessageKey = keyof typeof MESSAGE_TEMPLATES
export const MESSAGE_KEYS = Object.freeze(Object.keys(MESSAGE_TEMPLATES)) as readonly MessageKey[]
export const isMessageKey = (value: unknown): value is MessageKey => typeof value === 'string' && Object.hasOwn(MESSAGE_TEMPLATES, value)

export const DIGEST_LOCALES = ['en', 'it'] as const
export type DigestLocale = (typeof DIGEST_LOCALES)[number]

/** Code words the sentences use ({status}, {kind}), per language. */
export const CODE_WORDS = {
  status: { APPROVED: { en: 'approved', it: 'approvato' }, REJECTED: { en: 'rejected', it: 'rifiutato' } },
} as const

/** A param that is an amount: `{ $money: grain, value }` with `{ minor, currency }` or a margin % string. */
function figureText(params: Readonly<Record<string, unknown>>, locale: DigestLocale): string {
  const parts: string[] = []
  const net = params.netAmount
  if (isMarkedJson(net)) {
    const value = net.value as { minor?: unknown; currency?: unknown }
    if (typeof value?.minor === 'number' && typeof value.currency === 'string') parts.push(`${value.currency} ${fromMinorUnits(value.minor, value.currency).toFixed(minorPlaces(value.currency))}`)
  }
  const margin = params.marginPct
  if (isMarkedJson(margin) && typeof margin.value === 'string') parts.push(`${locale === 'it' ? 'margine' : 'margin'} ${new Dec(margin.value).toFixed(1)} %`)
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/**
 * A notification's sentence in a language: its key's template with the record's label, the people's names (unknown:
 * "Someone"), and the amounts its params hold (only those the reader was given). An unknown key says so plainly.
 */
export function sentenceOf(
  notification: { readonly messageKey: string; readonly params: unknown; readonly recordLabel: string; readonly actorId: string | null },
  names: ReadonlyMap<string, string>,
  locale: DigestLocale,
): string {
  const params = (notification.params && typeof notification.params === 'object' ? notification.params : {}) as Record<string, unknown>
  const template = isMessageKey(notification.messageKey) ? MESSAGE_TEMPLATES[notification.messageKey][locale] : locale === 'it' ? 'Novità su {record}' : 'News on {record}'
  const someone = locale === 'it' ? 'Qualcuno' : 'Someone'
  const actorId = typeof params.actorId === 'string' ? params.actorId : notification.actorId
  const status = typeof params.status === 'string' && Object.hasOwn(CODE_WORDS.status, params.status) ? CODE_WORDS.status[params.status as keyof typeof CODE_WORDS.status][locale] : String(params.status ?? '')
  const values: Record<string, string> = {
    actor: actorId ? (names.get(actorId) ?? someone) : locale === 'it' ? 'Il sistema' : 'The system',
    record: notification.recordLabel,
    title: typeof params.title === 'string' ? params.title : '',
    kind: typeof params.kindLabel === 'string' ? params.kindLabel : String(params.kind ?? ''),
    status,
    figure: figureText(params, locale),
    // B-W2b-385: the counts of a followed saved view.
    count: typeof params.count === 'number' ? String(params.count) : '',
    entered: typeof params.entered === 'number' ? String(params.entered) : '',
    left: typeof params.left === 'number' ? String(params.left) : '',
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
}

/**
 * A notification's params as its reader may see them NOW: an amount (marked with its grain) stays only while they hold
 * that grain (it was put there only when they held it at fan-out; a grain taken away since takes the amount away too).
 */
export function paramsFor(params: unknown, held: ReadonlySet<Grain>): Record<string, unknown> {
  const source = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(source).filter(([, value]) => !isMarkedJson(value) || held.has(value.$money)))
}

/** The user ids a notification's sentence names (to read their names once for a page). */
export function peopleOf(notification: { readonly params: unknown; readonly actorId: string | null }): string[] {
  const params = (notification.params && typeof notification.params === 'object' ? notification.params : {}) as Record<string, unknown>
  return [notification.actorId, typeof params.actorId === 'string' ? params.actorId : null].filter((id): id is string => typeof id === 'string')
}

// ---- grouping (PLT-142: "ORD-2026-0042: 10 changes in 5 minutes · Show") --------------------------------------------------

/** Notifications of one person, record and category this close together share a group. */
export const GROUP_WINDOW_MS = 15 * 60_000

/** The group key of a new notification: its neighbour's when that one is of the same person, record and category and recent enough; else its own id. */
export function groupKeyFor(previous: { readonly groupKey: string | null; readonly id: string; readonly createdAt: Date } | null, ownId: string, now: Date): string {
  if (previous && now.getTime() - previous.createdAt.getTime() <= GROUP_WINDOW_MS) return previous.groupKey ?? previous.id
  return ownId
}

// ---- snooze (H: "until a time or new activity") ---------------------------------------------------------------------------

export const SNOOZE_MAX_DAYS = 90
const DAY_MS = 86_400_000

/** What is wrong with a snooze until this time (null: nothing). A null time is "until there is new activity on the record". */
export function snoozeProblem(until: Date | null, now: Date): string | null {
  if (until === null) return null
  if (until.getTime() <= now.getTime()) return 'Snooze until a later time.'
  if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * DAY_MS) return `Snooze for at most ${SNOOZE_MAX_DAYS} days.`
  return null
}

/**
 * Whether a notification is snoozed now: until a time not yet come, or until new activity and none came (no newer
 * notification of the same person on the same record since it was snoozed).
 */
export function isSnoozedNow(notification: { readonly snoozedAt: Date | null; readonly snoozedUntil: Date | null }, now: Date, latestOnRecord: Date | null): boolean {
  if (notification.snoozedAt === null) return false
  if (notification.snoozedUntil !== null) return notification.snoozedUntil.getTime() > now.getTime()
  return latestOnRecord === null || latestOnRecord.getTime() <= notification.snoozedAt.getTime()
}

/** The state a notification is in now. */
export function stateOf(notification: { readonly doneAt: Date | null; readonly snoozedAt: Date | null; readonly snoozedUntil: Date | null }, now: Date, latestOnRecord: Date | null): NotificationState {
  if (notification.doneAt !== null) return 'DONE'
  return isSnoozedNow(notification, now, latestOnRecord) ? 'SNOOZED' : 'OPEN'
}

/** The most notifications one call marks (Mark read N, done, snooze). */
export const BULK_MAX = 200

// ---- the daily digest (the one way a notification reaches e-mail in W2a) --------------------------------------------------

/** The digest's ReportSubscription key (views.prisma): one per person, off by default (no row = off). */
export const DIGEST_REPORT_KEY = 'notifications.digest'
/** What a digest holds when the person turns it on without choosing: mentions, assignments, approvals and alerts. */
export const DIGEST_DEFAULT_CATEGORIES: readonly NotificationCategory[] = Object.freeze(['MENTION', 'ASSIGNMENT', 'APPROVAL', 'ALERT'])
export const DIGEST_DEFAULT_TIME = '08:00'
export const DIGEST_DEFAULT_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
/** The most notifications one digest lists (the rest: "and N more in the app"). */
export const DIGEST_MAX_ITEMS = 50
/** A digest looks back at most this far (the first one, or after a long pause). */
export const DIGEST_LOOKBACK_MS = 7 * DAY_MS

export interface DigestSettings {
  readonly on: boolean
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly categories: readonly NotificationCategory[]
}

const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** What is wrong with the digest's settings as sent (empty: nothing). */
export function digestProblems(settings: DigestSettings): Issue[] {
  const problems: Issue[] = []
  if (!SEND_TIME.test(settings.sendTime)) problems.push({ path: 'body/sendTime', message: 'A time of day is HH:MM.' })
  const days = settings.weekdays
  if (days.length === 0 || days.some((day, index) => !Number.isInteger(day) || day < 1 || day > 7 || (index > 0 && day <= days[index - 1]!))) problems.push({ path: 'body/weekdays', message: 'Weekdays are 1 (Monday) to 7 (Sunday), ascending, at least one.' })
  if (settings.categories.length === 0) problems.push({ path: 'body/categories', message: 'Choose at least one kind of notification.' })
  else if (new Set(settings.categories).size !== settings.categories.length) problems.push({ path: 'body/categories', message: 'A kind is listed twice.' })
  return problems
}

/** The digest's settings as stored (ReportSubscription.params.categories), read leniently. */
export function digestCategoriesOf(params: unknown): NotificationCategory[] {
  const value = (params as { categories?: unknown } | null)?.categories
  const listed = Array.isArray(value) ? value.filter((entry): entry is NotificationCategory => (NOTIFICATION_CATEGORIES as readonly unknown[]).includes(entry)) : []
  return listed.length > 0 ? [...new Set(listed)] : [...DIGEST_DEFAULT_CATEGORIES]
}

/**
 * Whether a digest is due: today (in its zone) is one of its weekdays, its time of day has come, and none was sent since
 * that moment. `clock` is HH:MM now in the zone; `sentToday` whether one went out today already.
 */
export function digestDue(settings: { readonly sendTime: string; readonly weekdays: readonly number[] }, at: { readonly weekday: number; readonly clock: string }, sentToday: boolean): boolean {
  return !sentToday && settings.weekdays.includes(at.weekday) && at.clock >= settings.sendTime
}

/** The digest's subject and text lines in a language (one line per notification, newest first). */
export function digestText(
  items: readonly { readonly messageKey: string; readonly params: unknown; readonly recordLabel: string; readonly actorId: string | null }[],
  more: number,
  names: ReadonlyMap<string, string>,
  locale: DigestLocale,
): { readonly subject: string; readonly lines: readonly string[] } {
  const count = items.length + more
  const subject = locale === 'it' ? `${count === 1 ? '1 notifica' : `${count} notifiche`} da guardare` : `${count === 1 ? '1 notification' : `${count} notifications`} to look at`
  const lines = items.map((item) => `• ${sentenceOf(item, names, locale)}`)
  if (more > 0) lines.push(locale === 'it' ? `… e altre ${more} nell’app.` : `… and ${more} more in the app.`)
  return { subject, lines }
}
