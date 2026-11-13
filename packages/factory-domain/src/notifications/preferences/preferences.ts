import type { Issue } from '../../core/errors'
import type { NotificationCategory } from '../rules'

/**
 * The notification preferences matrix (B-W2b-385; PLT-141; design home.notifications › Preferences: "event type × channel ×
 * cadence; role defaults shown with SourceIndicator ('Default for Planner'); quiet defaults on"), pure. The tables are
 * notify-depth.prisma (B-W2b-366): NotificationPreference (one office person's choice for one kind and channel) and
 * RoleNotificationDefault (an office role's default, set by whoever holds home.notifications.manage); apps/factory-api
 * platform/notifications/preferences applies them in the fan-out, the instant mail and push, and the daily digest.
 *
 * A cell's cadence is, in this order: the person's own choice → the defaults of the roles they hold (the loudest of them, so a
 * person with two roles hears what either role is meant to hear) → the QUIET default below. "Reset to my role's defaults"
 * removes the person's own rows.
 *
 * Quiet defaults (PLT-142 kept): in the app as it happens, every kind (what W2a did); by e-mail only in the daily digest, for
 * the kinds of the digest's own choice (W2a's `notifications.digest` categories: mentions, assignments, approvals and alerts
 * when the person never chose), and the digest goes out only once the person turned it on; on a phone only what is urgent
 * (design push-enrol "approvals, andon escalations, mentions"), and only on a device the person turned push on for.
 *
 * Off everywhere: no notification at all. Off in the app but on by e-mail or push: the notification is kept QUIET (read and
 * done the moment it is made, `madeQuiet`) so its deliveries have a row to name, and it never reaches the bell.
 */

export const EVENT_KINDS = ['MENTIONED', 'ASSIGNED', 'APPROVAL_WAITING', 'APPROVAL_DECIDED', 'FOLLOWING_CHANGED', 'AREA_ALERT', 'MAIL_ASSIGNED'] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export const isEventKind = (value: unknown): value is EventKind => typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value)

export const PREFERENCE_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number]

export const CADENCES = ['INSTANT', 'DAILY_DIGEST', 'OFF'] as const
export type Cadence = (typeof CADENCES)[number]

/** The cadences a channel offers: the daily digest is an e-mail (W2a's), so the app and push take as it happens or off. */
export const cadencesOf = (channel: PreferenceChannel): readonly Cadence[] => (channel === 'EMAIL' ? CADENCES : ['INSTANT', 'OFF'])

/** Where a cell's cadence comes from (the matrix's SourceIndicator). */
export const PREFERENCE_SOURCES = ['PERSON', 'ROLE', 'QUIET'] as const
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number]

/** The notification category each kind's notifications carry (the tabs of home.notifications, the digest's W2a choice). */
export const KIND_CATEGORY: Readonly<Record<EventKind, NotificationCategory>> = Object.freeze({
  MENTIONED: 'MENTION',
  ASSIGNED: 'ASSIGNMENT',
  APPROVAL_WAITING: 'APPROVAL',
  APPROVAL_DECIDED: 'APPROVAL',
  FOLLOWING_CHANGED: 'FOLLOWING',
  AREA_ALERT: 'ALERT',
  MAIL_ASSIGNED: 'ASSIGNMENT',
})

/** What is urgent enough for a phone by default (design push-enrol: approvals, andon escalations, mentions). */
export const URGENT_KINDS: readonly EventKind[] = Object.freeze(['MENTIONED', 'APPROVAL_WAITING', 'AREA_ALERT'])

/**
 * The APPROVAL sentences that tell a decision (to the person who asked); every other APPROVAL sentence asks for one (an
 * approval waits for me, or its asker nudged me). A rule that adds a decision sentence lists it here (one line).
 */
export const DECIDED_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  'notifications.approval.quote_decided',
  'notifications.approval.taskDecided',
  'notifications.changes.orderDecided',
  // B-W2b-385 (NT1:01): a request to buy drafted into a purchase order, or refused by the buyer.
  'notifications.purchasing.requestOrdered',
  'notifications.purchasing.requestRefused',
])

/** The ASSIGNMENT sentences of a mail given to a person (a team inbox's mail, B-W2b-394): their message keys start so. */
export const MAIL_ASSIGNED_PREFIX = 'notifications.mail.'

/** The kind of a notification (a row of the matrix), or null for SYSTEM news, which the matrix does not list (in the app). */
export function kindOf(notification: { readonly category: string; readonly messageKey: string }): EventKind | null {
  switch (notification.category) {
    case 'MENTION':
      return 'MENTIONED'
    case 'ASSIGNMENT':
      return notification.messageKey.startsWith(MAIL_ASSIGNED_PREFIX) ? 'MAIL_ASSIGNED' : 'ASSIGNED'
    case 'APPROVAL':
      return DECIDED_MESSAGE_KEYS.has(notification.messageKey) ? 'APPROVAL_DECIDED' : 'APPROVAL_WAITING'
    case 'ALERT':
      return 'AREA_ALERT'
    case 'FOLLOWING':
      return 'FOLLOWING_CHANGED'
    default:
      return null
  }
}

/** The cadence nobody chose (see the module comment). `digestCategories`: the person's digest choice (W2a), or its default. */
export function quietDefault(kind: EventKind, channel: PreferenceChannel, digestCategories: readonly NotificationCategory[]): Cadence {
  if (channel === 'IN_APP') return 'INSTANT'
  if (channel === 'EMAIL') return digestCategories.includes(KIND_CATEGORY[kind]) ? 'DAILY_DIGEST' : 'OFF'
  return URGENT_KINDS.includes(kind) ? 'INSTANT' : 'OFF'
}

/** The one-row-per-person key the database checks (NotificationPreference.key). */
export const preferenceKey = (userId: string, event: EventKind, channel: PreferenceChannel): string => `pref:${userId}:${event}:${channel}`
/** The one-row-per-role key (RoleNotificationDefault.key). */
export const roleDefaultKey = (roleId: string, event: EventKind, channel: PreferenceChannel): string => `default:${roleId}:${event}:${channel}`

export interface ChosenCell {
  readonly event: EventKind
  readonly channel: PreferenceChannel
  readonly cadence: Cadence
}

export interface RoleCell extends ChosenCell {
  readonly roleId: string
}

export interface MatrixCell {
  readonly event: EventKind
  readonly channel: PreferenceChannel
  readonly cadence: Cadence
  readonly source: PreferenceSource
  /** The role whose default it is (source ROLE), else null. */
  readonly roleId: string | null
  /** The quiet default (what "Reset" or a role default removed gives back when no role speaks). */
  readonly quiet: Cadence
}

const LOUDNESS: Readonly<Record<Cadence, number>> = Object.freeze({ INSTANT: 2, DAILY_DIGEST: 1, OFF: 0 })

/**
 * The person's whole matrix (7 kinds × 3 channels, in the design's order): their own row, else the loudest default of their
 * roles (`roles` in the order the person was given them: the first wins a tie), else the quiet default. A stored cadence a
 * channel does not offer (none can be stored: the database refuses it) falls through.
 */
export function resolveMatrix(input: { readonly person: readonly ChosenCell[]; readonly roles: readonly RoleCell[]; readonly digestCategories: readonly NotificationCategory[] }): MatrixCell[] {
  const cells: MatrixCell[] = []
  for (const event of EVENT_KINDS) {
    for (const channel of PREFERENCE_CHANNELS) {
      const offered = cadencesOf(channel)
      const quiet = quietDefault(event, channel, input.digestCategories)
      const own = input.person.find((cell) => cell.event === event && cell.channel === channel && offered.includes(cell.cadence))
      if (own) {
        cells.push({ event, channel, cadence: own.cadence, source: 'PERSON', roleId: null, quiet })
        continue
      }
      let best: RoleCell | null = null
      for (const cell of input.roles) {
        if (cell.event !== event || cell.channel !== channel || !offered.includes(cell.cadence)) continue
        if (best === null || LOUDNESS[cell.cadence] > LOUDNESS[best.cadence]) best = cell
      }
      cells.push(best ? { event, channel, cadence: best.cadence, source: 'ROLE', roleId: best.roleId, quiet } : { event, channel, cadence: quiet, source: 'QUIET', roleId: null, quiet })
    }
  }
  return cells
}

/** One cell of a resolved matrix. */
export function cadenceIn(cells: readonly MatrixCell[], event: EventKind, channel: PreferenceChannel): Cadence {
  return cells.find((cell) => cell.event === event && cell.channel === channel)?.cadence ?? 'OFF'
}

/** What a notification of a kind does for a person: reach the bell, an e-mail now, the digest, a push now. Null kind: SYSTEM. */
export interface KindChoice {
  /** False: nothing at all is made (off everywhere). */
  readonly made: boolean
  /** False: kept quiet (read and done at once), only for its deliveries. */
  readonly inApp: boolean
  readonly emailNow: boolean
  readonly digest: boolean
  readonly pushNow: boolean
}

export function choiceFor(cells: readonly MatrixCell[], kind: EventKind | null): KindChoice {
  if (kind === null) return { made: true, inApp: true, emailNow: false, digest: false, pushNow: false }
  const inApp = cadenceIn(cells, kind, 'IN_APP') === 'INSTANT'
  const email = cadenceIn(cells, kind, 'EMAIL')
  const pushNow = cadenceIn(cells, kind, 'PUSH') === 'INSTANT'
  const emailNow = email === 'INSTANT'
  const digest = email === 'DAILY_DIGEST'
  return { made: inApp || emailNow || digest || pushNow, inApp, emailNow, digest, pushNow }
}

/** What is wrong with one cell as sent (null: nothing). The database refuses the same. */
export function cellProblem(cell: { readonly event: string; readonly channel: string; readonly cadence: string | null }): Issue | null {
  if (!isEventKind(cell.event)) return { path: 'body/event', message: 'Choose one of the kinds of news of the matrix.' }
  if (!(PREFERENCE_CHANNELS as readonly string[]).includes(cell.channel)) return { path: 'body/channel', message: 'Choose in the app, e-mail or push.' }
  if (cell.cadence !== null && !cadencesOf(cell.channel as PreferenceChannel).includes(cell.cadence as Cadence)) {
    return { path: 'body/cadence', message: cell.cadence === 'DAILY_DIGEST' ? 'Only e-mail has a daily digest: choose as it happens or off here.' : 'Choose as it happens, the daily digest (e-mail) or off.' }
  }
  return null
}

/**
 * A notification kept quiet: made only for its deliveries (off in the app, on by e-mail or push), read and done the moment it
 * was made. The person's own "done" always comes later, so the two never meet.
 */
export function madeQuiet(row: { readonly doneAt: Date | null; readonly readAt: Date | null; readonly createdAt: Date }): boolean {
  return row.doneAt !== null && row.readAt !== null && row.doneAt.getTime() === row.createdAt.getTime() && row.readAt.getTime() === row.createdAt.getTime()
}
