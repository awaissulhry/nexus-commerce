import { defineDesignScreen } from '../../../lib/design/design-screen'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { rowsOf, type Digest, type Notification, type NotificationCounts, type NotificationsViewModel } from './model'
import { NotificationsView } from './view/NotificationsView'

/**
 * SCR-005 Notifications — made-up data only (PLAN §3.1): names, numbers and records are invented ("Demo" people,
 * example records). Each case is one state the Owner reviews: the mixed list (a mention, a task given to me, an
 * approval with its figure, a decision, an alert, a followed record's notes folded together, a machine report), one
 * tab, rows selected (Mark read N), the snoozed and done lists, the digest preferences off and on, the snooze dialog,
 * the Undo after Done, new rows waiting, the keys, offline (writes held), loading, error, empty, no permission.
 */

const PREFIX = '/w/DEMO'
/** 29 Oct 2026, 10:42 in Rome (CET). */
const NOW = Date.UTC(2026, 9, 29, 9, 42)
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

const PEOPLE = {
  marta: '0190f0e2-3333-7000-8000-000000000011',
  luca: '0190f0e2-3333-7000-8000-000000000012',
  fiona: '0190f0e2-3333-7000-8000-000000000013',
} as const
const NAMES: Record<string, string> = { [PEOPLE.marta]: 'Marta Demo', [PEOPLE.luca]: 'Luca Esempio', [PEOPLE.fiona]: 'Fiona Prova' }

let seq = 0
function note(overrides: Partial<Notification> & Pick<Notification, 'category' | 'messageKey' | 'record'>): Notification {
  seq += 1
  const id = `0190f0e2-7777-7000-8000-${String(seq).padStart(12, '0')}`
  return {
    id,
    eventType: 'thread.user_mentioned',
    companyId: '0190f0e2-1111-7000-8000-000000000001',
    anchor: null,
    params: {},
    sentence: '',
    actor: null,
    people: NAMES,
    state: 'OPEN',
    read: false,
    readAt: null,
    doneAt: null,
    snoozed: null,
    createdAt: at(29, 9, 30),
    group: { key: id, count: 1, ids: [id] },
    ...overrides,
  }
}

const mention = note({ category: 'MENTION', messageKey: 'notifications.mentioned', record: { type: 'SalesOrder', id: '0190f0e2-2222-7000-8000-000000000042', label: 'ORD-2026-0042' }, actor: { id: PEOPLE.marta, name: 'Marta Demo' }, params: { actorId: PEOPLE.marta }, anchor: 'message:0190f0e2-5555-7000-8000-000000000001', createdAt: at(29, 9, 31) })
const task = note({ category: 'ASSIGNMENT', eventType: 'task.assigned', messageKey: 'notifications.assigned.task', record: { type: 'PurchaseOrder', id: '0190f0e2-2222-7000-8000-000000000031', label: 'PO-2026-0031' }, actor: { id: PEOPLE.luca, name: 'Luca Esempio' }, params: { actorId: PEOPLE.luca, title: 'Call the tannery about lot L-88' }, anchor: 'task:0190f0e2-6666-7000-8000-000000000001', createdAt: at(29, 8, 55) })
const approval = note({ category: 'APPROVAL', eventType: 'quote.approval_requested', messageKey: 'notifications.approval.quote_requested', record: { type: 'Quote', id: '0190f0e2-2222-7000-8000-000000000142', label: 'Q-2026-0142' }, actor: { id: PEOPLE.marta, name: 'Marta Demo' }, params: { actorId: PEOPLE.marta, netAmount: { $money: 'price', value: { minor: 624000, currency: 'EUR' } }, marginPct: { $money: 'margin', value: '18.20' } }, anchor: 'approval:0190f0e2-4444-7000-8000-000000000001', createdAt: at(29, 7, 40) })
const decided = note({ category: 'APPROVAL', eventType: 'quote.approval_decided', messageKey: 'notifications.approval.quote_decided', record: { type: 'Quote', id: '0190f0e2-2222-7000-8000-000000000139', label: 'Q-2026-0139' }, actor: { id: PEOPLE.fiona, name: 'Fiona Prova' }, params: { actorId: PEOPLE.fiona, status: 'APPROVED' }, read: true, readAt: at(28, 16), createdAt: at(28, 15, 12) })
const alert = note({ category: 'ALERT', eventType: 'alert.raised', messageKey: 'notifications.alert.raised', record: { type: 'SalesOrder', id: '0190f0e2-2222-7000-8000-000000000044', label: 'ORD-2026-0044' }, params: { title: 'Order at risk of being late' }, anchor: 'alert:0190f0e2-8888-7000-8000-000000000001', createdAt: at(27, 7, 20) })
const followingIds = ['0190f0e2-7777-7000-8000-100000000001', '0190f0e2-7777-7000-8000-100000000002', '0190f0e2-7777-7000-8000-100000000003']
const following = note({ category: 'FOLLOWING', eventType: 'thread.message_posted', messageKey: 'notifications.following.note', record: { type: 'WorkOrder', id: '0190f0e2-2222-7000-8000-000000000098', label: 'WO-0098' }, actor: { id: PEOPLE.luca, name: 'Luca Esempio' }, params: { actorId: PEOPLE.luca }, read: true, readAt: at(29, 8), createdAt: at(29, 7, 5), group: { key: followingIds[0]!, count: 3, ids: followingIds } })
const plant = note({ category: 'SYSTEM', eventType: 'plant.request_reported', messageKey: 'notifications.plant.reported', record: { type: 'Machine', id: '0190f0e2-2222-7000-8000-000000000201', label: 'CUT-PRESS-02' }, params: { title: 'Blade does not come down' }, createdAt: at(26, 13, 10) })
/** The same approval for a reader without the price and margin grains: the API sent it without the amounts. */
const approvalNoGrain = { ...approval, params: { actorId: PEOPLE.marta } }

const ALL = [mention, task, approval, following, decided, alert, plant]

const counts = (unread: number, tabs: Partial<Record<NotificationCounts['tabs'][number]['tab'], number>>, complete = true): NotificationCounts => ({
  unread,
  complete,
  tabs: (['ALL', 'MENTION', 'ASSIGNMENT', 'APPROVAL', 'SYSTEM'] as const).map((tab) => ({ tab, unread: tab === 'ALL' ? unread : (tabs[tab] ?? 0) })),
})
const COUNTS = counts(5, { MENTION: 1, ASSIGNMENT: 1, APPROVAL: 1, SYSTEM: 2 })

const digest = (overrides: Partial<Digest> = {}): Digest => ({ on: false, sendTime: '08:00', weekdays: [1, 2, 3, 4, 5], categories: ['MENTION', 'ASSIGNMENT', 'APPROVAL', 'ALERT'], locale: null, lastSentAt: null, version: 0, ...overrides })

function model(items: readonly Notification[] = ALL, overrides: Partial<NotificationsViewModel> = {}): NotificationsViewModel {
  return {
    access: 'open',
    now: NOW,
    live: 'live',
    prefix: PREFIX,
    tab: 'ALL',
    state: 'OPEN',
    counts: COUNTS,
    list: { status: 'ready', data: { asOf: new Date(NOW).toISOString(), items: rowsOf(items, PREFIX, OFFICE_PAGES), more: false, loadingMore: false, fresh: 0 } },
    selected: [],
    busy: false,
    notice: null,
    dialog: null,
    ...overrides,
  }
}

const snoozedRows = [
  { ...task, state: 'SNOOZED' as const, read: true, snoozed: { at: at(29, 9), until: at(30, 7) } },
  { ...mention, state: 'SNOOZED' as const, read: true, snoozed: { at: at(29, 9, 5), until: null } },
]
const doneRows = [
  { ...decided, state: 'DONE' as const, doneAt: at(28, 16, 5) },
  { ...plant, state: 'DONE' as const, read: true, doneAt: at(27, 8) },
]

export const designScreen = defineDesignScreen<NotificationsViewModel>({
  screen: 'SCR-005',
  title: 'Notification centre',
  view: NotificationsView,
  cases: [
    { id: 'normal', label: 'Everything I was told (All)', model: model(), note: 'Each row is one sentence in my language: a mention, a task given to me, an approval with its figure (only with the price and margin grains), a decision, an alert, three notes on a record I follow folded together, a machine report. Unread rows are bold with a dot; the record is a real link; Today · Yesterday · Earlier.' },
    { id: 'mentions', label: 'The Mentions tab', model: model([mention], { tab: 'MENTION' }), note: 'A tile is a saved filter: pressed, it shows its unread count and filters the list.' },
    { id: 'selected', label: 'Two rows selected: Mark read 2', model: model(ALL, { selected: [mention.id, task.id], focusRow: 0 }), note: 'The toolbar swaps to Mark read 2 · Done 2 · Snooze 2 · Clear; the header box is mixed.' },
    { id: 'grouped', label: 'Notes on one record folded together', model: model([following, decided], { counts: counts(0, {}) }), note: '"3 together": notifications of one record and kind that came within 15 minutes are one row; Done or Snooze acts on all three.' },
    { id: 'no-grain', label: 'An approver without the price grain', model: model([approvalNoGrain], { tab: 'APPROVAL', counts: counts(1, { APPROVAL: 1 }) }), note: 'The same request with no amount: the API dropped it for a reader without the grain (PLT-152).' },
    { id: 'snoozed', label: 'Snoozed', model: model(snoozedRows, { state: 'SNOOZED' }), note: 'Until a time, or until something changes on the record. Select → Back now N.' },
    { id: 'done', label: 'Done', model: model(doneRows, { state: 'DONE' }), note: 'What I marked done; Back to the list N puts them back.' },
    { id: 'snooze', label: 'Snooze until (H)', model: model(ALL, { dialog: { kind: 'snooze', ids: [task.id], what: 'PO-2026-0031' } }), note: 'Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date · Until something changes on the record.' },
    { id: 'preferences', label: 'Preferences: the daily digest (off)', model: model(ALL, { dialog: { kind: 'digest', digest: { status: 'ready', data: digest() }, saving: false, problem: null } }), note: 'Quiet by default: nothing is e-mailed until the person turns the digest on. The full matrix (W2b) is said to come later.' },
    { id: 'preferences-on', label: 'Preferences: the digest on', model: model(ALL, { dialog: { kind: 'digest', digest: { status: 'ready', data: digest({ on: true, sendTime: '07:30', weekdays: [1, 3, 5], locale: 'it', lastSentAt: at(28, 6, 30), version: 3 }) }, saving: false, problem: null } }) },
    { id: 'preferences-changed', label: 'Preferences changed meanwhile (409)', model: model(ALL, { dialog: { kind: 'digest', digest: { status: 'ready', data: digest({ version: 2 }) }, saving: false, problem: 'digest.problem.changed' } }) },
    { id: 'after-done', label: 'After Done: Undo', model: model(ALL.filter((row) => row !== mention), { notice: { key: 'notice.done', tone: 'success', params: { count: 1 }, undo: { ids: [mention.id] } } }), note: 'Done leaves the list at once; the notice offers Undo.' },
    { id: 'fresh', label: 'New notifications wait behind "2 updates · Show"', model: model(ALL, { list: { status: 'ready', data: { asOf: new Date(NOW).toISOString(), items: rowsOf(ALL, PREFIX, OFFICE_PAGES), more: true, loadingMore: false, fresh: 2 } } }), note: 'notification.created never moves the rows under the cursor; Show more reads the next page.' },
    { id: 'keys', label: 'The keys, in the footer icon', model: model(ALL, { focusRow: 1, keysOpen: true }), note: 'Enter open · e done · h snooze · m mute the record · ⇧E mark all read, then the frame’s j / k, x, ⇧-click, ?.' },
    { id: 'many', label: 'More than 1000 unread', model: model(ALL, { counts: counts(1000, { MENTION: 300, ASSIGNMENT: 200, APPROVAL: 100, SYSTEM: 400 }, false) }) },
    { id: 'offline', label: 'Offline: writes held', model: model(ALL, { live: 'offline' }), note: 'The list stays readable; Mark all read and every bulk action are held with the reason.' },
    { id: 'empty', label: 'Nothing to look at', model: model([], { counts: counts(0, {}) }), note: '"No notifications. You are told about mentions, assignments, approvals and records you follow."' },
    { id: 'empty-tab', label: 'Nothing in one tab', model: model([], { tab: 'SYSTEM', counts: counts(2, { MENTION: 1, ASSIGNMENT: 1 }) }) },
    { id: 'loading', label: 'Loading', model: model([], { list: { status: 'loading' }, counts: null }) },
    { id: 'error', label: 'Error', model: model([], { list: { status: 'error', problem: 'problem.offline' }, counts: null }) },
    { id: 'no-permission', label: 'No permission (home.view)', model: model([], { access: 'refused', list: { status: 'loading' }, counts: null }) },
  ],
})
