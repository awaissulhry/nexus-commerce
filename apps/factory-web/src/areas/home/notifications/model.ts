import { z } from 'zod'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_STATES, NOTIFICATION_TABS, type NotificationCategory, type NotificationState, type NotificationTab } from '@nexus/factory-domain/notifications/rules'
import { recordAddress } from '../../../lib/records/record-links'
import { plusDays, wallClock } from '../today/snooze'

/**
 * Home › Notifications (SCR-005; design home.notifications, W2a; PLT-138 in-app centre, PLT-142 quiet defaults, PLT-152
 * text per reader): what the API answers (apps/factory-api platform/notifications: GET /notifications, GET
 * /notifications/counts, GET|PUT /notifications/digest) and the ONE view model the screen draws. Every notification is
 * the reader's own; its words are its message key and params (the web's `home-notifications` catalogue says them in the
 * person's language), an amount in its params only when the reader holds that grain (the API dropped the rest). Nothing
 * here counts or names other people's work.
 */

export { NOTIFICATION_CATEGORIES, NOTIFICATION_STATES, NOTIFICATION_TABS }
export type { NotificationCategory, NotificationState, NotificationTab }

// ---- the API's answers ------------------------------------------------------------------------------------------------

export const notificationSchema = z.object({
  id: z.string(),
  category: z.enum(NOTIFICATION_CATEGORIES),
  eventType: z.string(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  companyId: z.string().nullable(),
  /** Where it opens on its record: `message:<id>`, `task:<id>`, `today:<row key>`, `approval:<id>`, `alert:<id>`. */
  anchor: z.string().nullable(),
  messageKey: z.string(),
  /** Grained JSON: an amount is `{ $money: grain, value }`, present only while the reader holds its grain. */
  params: z.unknown(),
  /** English; the screen draws `messageKey` with `params` in the person's language. */
  sentence: z.string(),
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  people: z.record(z.string(), z.string()),
  state: z.enum(NOTIFICATION_STATES),
  read: z.boolean(),
  readAt: z.string().nullable(),
  doneAt: z.string().nullable(),
  snoozed: z.object({ at: z.string(), until: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  group: z.object({ key: z.string(), count: z.number().int(), ids: z.array(z.string()) }),
})
export type Notification = z.infer<typeof notificationSchema>

const tabCountsSchema = z.array(z.object({ tab: z.enum(NOTIFICATION_TABS), unread: z.number().int() }))

export const countsSchema = z.object({
  asOf: z.string().optional(),
  unread: z.number().int(),
  /** False: more than 1000 unread (the bell says "999+" and the page "more than"). */
  complete: z.boolean(),
  tabs: tabCountsSchema,
})
export type NotificationCounts = z.infer<typeof countsSchema>

export const listSchema = z.object({
  asOf: z.string(),
  tab: z.enum(NOTIFICATION_TABS),
  state: z.enum(NOTIFICATION_STATES),
  counts: countsSchema,
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  live: z.object({ events: z.array(z.string()) }),
})
export type NotificationList = z.infer<typeof listSchema>

export const changedSchema = z.object({ changed: z.number().int(), unknown: z.array(z.string()) })

export const digestSchema = z.object({
  digest: z.object({
    on: z.boolean(),
    sendTime: z.string(),
    weekdays: z.array(z.number().int()),
    categories: z.array(z.enum(NOTIFICATION_CATEGORIES)),
    locale: z.string().nullable(),
    lastSentAt: z.string().nullable(),
    version: z.number().int(),
  }),
})
export type Digest = z.infer<typeof digestSchema>['digest']
export type DigestDraft = Pick<Digest, 'on' | 'sendTime' | 'weekdays' | 'categories'>

// ---- the view model ---------------------------------------------------------------------------------------------------

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: T }

export type LiveState = 'connecting' | 'live' | 'offline'

/** A notification as the list draws it: where it opens (at its place) and where its record opens. */
export interface NotificationRow extends Notification {
  /** Enter, the sentence: the record at the notification's place (the message, the task, Today's row, the approval). */
  readonly href: string
  /** The record chip: the record itself (a real link: ⌘-click opens a new tab). */
  readonly recordHref: string
}

export interface NotificationsData {
  readonly asOf: string
  readonly items: readonly NotificationRow[]
  readonly more: boolean
  readonly loadingMore: boolean
  /** New notifications a live change brought, waiting behind "N new · Show" (rows never move under the cursor). */
  readonly fresh: number
}

export interface Notice {
  readonly key: string
  readonly tone: 'success' | 'warning' | 'danger' | 'info'
  readonly params?: Readonly<Record<string, string | number>>
  /** An Undo the notice offers (done → back to the list). */
  readonly undo?: { readonly ids: readonly string[] } | null
}

/** The dialogs the page opens over the list. */
export type NotificationsDialog =
  | { readonly kind: 'snooze'; readonly ids: readonly string[]; readonly what: string }
  | { readonly kind: 'digest'; readonly digest: Loaded<Digest>; readonly saving: boolean; readonly problem: string | null }

export interface NotificationsViewModel {
  /** The person may open Home (home.view); else the page says so and loads nothing. */
  readonly access: 'open' | 'refused'
  /** The page's clock (AsOf, Today · Yesterday · Earlier, the snooze choices). */
  readonly now: number
  readonly live: LiveState
  readonly prefix: string
  readonly tab: NotificationTab
  readonly state: NotificationState
  /** The unread counts (the tabs and the band); null while unknown. */
  readonly counts: NotificationCounts | null
  readonly list: Loaded<NotificationsData>
  /** The ticked rows' ids (a folded group is one row: its id). */
  readonly selected: readonly string[]
  readonly busy: boolean
  readonly notice: Notice | null
  readonly dialog: NotificationsDialog | null
  /** Design cases: the row that has the focus, the keys panel open. */
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

// ---- rules of the screen ------------------------------------------------------------------------------------------------

/** The tab in the address, or All. */
export function tabOf(value: string | null): NotificationTab {
  return (NOTIFICATION_TABS as readonly string[]).includes(value ?? '') ? (value as NotificationTab) : 'ALL'
}

/** The state in the address, or "to look at" (OPEN). */
export function stateOf(value: string | null): NotificationState {
  return (NOTIFICATION_STATES as readonly string[]).includes(value ?? '') ? (value as NotificationState) : 'OPEN'
}

/** Today · Yesterday · Earlier, by the site's calendar day of the notification and of now. */
export type WhenGroup = 'TODAY' | 'YESTERDAY' | 'EARLIER'
export function whenGroup(createdAt: string, now: number): WhenGroup {
  const day = wallClock(Date.parse(createdAt)).day
  const today = wallClock(now).day
  if (day === today) return 'TODAY'
  if (day === plusDays(today, -1)) return 'YESTERDAY'
  return 'EARLIER'
}

/** Every notification a row stands for (a folded group acts on all of its ids). */
export function idsOf(rows: readonly Pick<Notification, 'id' | 'group'>[], picked: readonly string[]): string[] {
  const wanted = new Set(picked)
  return [...new Set(rows.filter((row) => wanted.has(row.id)).flatMap((row) => (row.group.ids.length > 0 ? row.group.ids : [row.id])))]
}

/**
 * Where a notification opens (design: "Enter opens the record at the place (the message, the field)"): a task in My
 * tasks' detail, a Today row on Today, an approval in Approvals' review, an alert or a message on its record; the record
 * itself when nothing more precise is known. Company-free; the caller adds `/w/<company>`.
 */
export function openAddress(notification: Pick<Notification, 'anchor' | 'record' | 'companyId'>, built: ReadonlySet<string>): string {
  const record = { type: notification.record.type, id: notification.record.id, label: notification.record.label, companyId: notification.companyId }
  const anchor = notification.anchor ?? ''
  const at = anchor.indexOf(':')
  const kind = at < 0 ? '' : anchor.slice(0, at)
  const id = at < 0 ? '' : anchor.slice(at + 1)
  if (kind === 'task' && id) return recordAddress({ type: 'Task', id }, built)
  if (kind === 'today' && id && built.has('/home/today')) return `/home/today?open=${encodeURIComponent(id)}`
  if (kind === 'approval' && id && built.has('/home/approvals')) return `/home/approvals?open=${encodeURIComponent(id)}`
  if (kind === 'alert' && id) return recordAddress({ type: 'Alert', id, label: notification.record.label, companyId: notification.companyId }, built)
  return recordAddress(record, built)
}

/** The rows of a page as the screen draws them, with where each opens. */
export function rowsOf(items: readonly Notification[], prefix: string, built: ReadonlySet<string>): NotificationRow[] {
  return items.map((item) => ({
    ...item,
    href: `${prefix}${openAddress(item, built)}`,
    recordHref: `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId }, built)}`,
  }))
}

/** How many notifications of a fresh first page the screen does not show yet. */
export function freshCount(shown: readonly { readonly id: string }[], fetched: readonly { readonly id: string }[]): number {
  const seen = new Set(shown.map((item) => item.id))
  return fetched.filter((item) => !seen.has(item.id)).length
}

/** The unread count of a tab ("—" while unknown is the view's). */
export function unreadOf(counts: NotificationCounts | null, tab: NotificationTab): number | null {
  if (!counts) return null
  return counts.tabs.find((entry) => entry.tab === tab)?.unread ?? 0
}

/** The page's keys: E done, H snooze, M mute the record, ⇧E mark all read (the frame adds j / k, Enter, x …). */
export type PageKey = 'done' | 'snooze' | 'mute' | 'allRead'
export function pageKey(event: { readonly key: string; readonly shiftKey: boolean }): PageKey | null {
  if (event.key === 'E' && event.shiftKey) return 'allRead'
  if (event.shiftKey) return null
  if (event.key === 'e') return 'done'
  if (event.key === 'h') return 'snooze'
  if (event.key === 'm') return 'mute'
  return null
}

/** Why a write is held now (a message key of `home-notifications`), or null. */
export function writeHeld(state: { readonly live: LiveState; readonly busy: boolean }): string | null {
  if (state.live === 'offline') return 'held.offline'
  if (state.busy) return 'held.busy'
  return null
}

/** What is wrong with the digest as the person set it (a message key), or null. */
export const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
export function digestProblem(draft: DigestDraft): string | null {
  if (!SEND_TIME.test(draft.sendTime)) return 'digest.problem.time'
  if (draft.weekdays.length === 0) return 'digest.problem.days'
  if (draft.categories.length === 0) return 'digest.problem.kinds'
  return null
}

/** The digest's times of day offered (every half hour, 06:00 to 20:00) and the stored one if it is another. */
export function digestTimes(current: string): string[] {
  const times: string[] = []
  for (let hour = 6; hour <= 20; hour += 1) for (const minute of ['00', '30']) times.push(`${String(hour).padStart(2, '0')}:${minute}`)
  return times.includes(current) || !SEND_TIME.test(current) ? times : [...times, current].sort()
}

/** The live event after which the list and the bell read again (the API's `live.events`). */
export const LIVE_EVENTS: readonly string[] = Object.freeze(['notification.created'])

/** The window event the page sends after it changed the person's notifications: the bell reads its count again. */
export const NOTIFICATIONS_CHANGED = 'factory:notifications-changed'

/** The bell (top bar): its count in words, never 0 for an unknown count (design shell.frame top-bar). */
export type BellState = { readonly status: 'loading' } | { readonly status: 'error' } | { readonly status: 'ready'; readonly unread: number; readonly complete: boolean }

/** The bell's words (a `shell` key and its count) and the number on its badge (null: no badge). */
export function bellWords(bell: BellState): { readonly key: string; readonly count: number; readonly badge: number | null } {
  if (bell.status === 'loading') return { key: 'topbar.bell.label', count: 0, badge: null }
  if (bell.status === 'error') return { key: 'topbar.bell.unknown', count: 0, badge: null }
  if (!bell.complete) return { key: 'topbar.bell.countMore', count: bell.unread, badge: bell.unread }
  if (bell.unread === 0) return { key: 'topbar.bell.none', count: 0, badge: null }
  return { key: 'topbar.bell.count', count: bell.unread, badge: bell.unread }
}
