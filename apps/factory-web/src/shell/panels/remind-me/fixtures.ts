import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Reminder } from './api'
import { RemindMeCase, type RemindMeCaseModel } from './view/RemindMeCase'

/**
 * SCR-543 — Remind me (B-W2b-388; design shell.panels popup remind-me and side panel "Reminders I set"; COL-041). Made-up data
 * only. The pop-up's choices are worked out from 13 Nov 2026 09:30 in Rome (a Friday): later today 16:00, tomorrow, Monday.
 */

const NOW = Date.UTC(2026, 10, 13, 8, 30)
const id = (n: number) => `0190f0e2-aaaa-7000-8000-${String(n).padStart(12, '0')}`
const RECORD = { type: 'PurchaseOrder', id: id(1), label: 'PO-2026-0031' }

function reminder(n: number, extra: Partial<Reminder>): Reminder {
  return {
    id: id(100 + n),
    record: RECORD,
    companyId: id(900),
    messageId: null,
    kind: 'AT_TIME',
    remindAt: new Date(NOW + 23.5 * 3_600_000).toISOString(),
    since: new Date(NOW - 3_600_000).toISOString(),
    note: null,
    cameBackAt: null,
    doneAt: null,
    state: 'WAITING',
    version: 1,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    ...extra,
  }
}

const MINE: Reminder[] = [
  reminder(1, { note: 'Supplier promised a date' }),
  reminder(2, { kind: 'ON_CHANGE', remindAt: null, messageId: id(50), note: 'When they answer about the lining' }),
  reminder(3, { state: 'CAME_BACK', cameBackAt: new Date(NOW - 15 * 60_000).toISOString(), remindAt: new Date(NOW - 15 * 60_000).toISOString() }),
]

const set = (items: readonly Reminder[]): RemindMeCaseModel['set'] => ({ reminders: { status: 'ready', items }, held: null, notice: null })
const dialog = { what: RECORD.label, aboutMessage: false, now: NOW, held: null, problem: null }

export const designScreen = defineDesignScreen<RemindMeCaseModel>({
  screen: 'SCR-543',
  title: 'Remind me and the reminders I set (B-W2b-388)',
  view: RemindMeCase,
  part: true,
  cases: [
    { id: 'reminders-set', label: 'Reminders I set on a record', model: { set: set(MINE), dialog: null }, note: 'Beside Follow: Remind me, then my open reminders on the record — when each comes back, one about a message, one that came back — with Done and Remove. Only mine.' },
    { id: 'dialog', label: 'Remind me (the record)', model: { set: set(MINE), dialog }, note: 'Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date · When something changes; my note first (optional). ↑ / ↓ between the choices, Enter sets.' },
    { id: 'dialog-message', label: 'Remind me (a message)', model: { set: set(MINE), dialog: { ...dialog, aboutMessage: true } }, note: 'Opened from a message of the record’s conversation: the reminder opens the record at the message.' },
    { id: 'dialog-offline', label: 'Remind me offline', model: { set: { ...set(MINE), held: 'remind.held.offline' }, dialog: { ...dialog, held: 'remind.held.offline' } }, note: 'Every choice held with the reason; nothing is lost.' },
    { id: 'dialog-problem', label: 'Remind me refused', model: { set: set(MINE), dialog: { ...dialog, problem: 'remind.problem.tooMany' } }, note: 'The API’s refusal in words above the choices (500 open reminders).' },
    { id: 'set-notice', label: 'After setting one', model: { set: { ...set(MINE), notice: { key: 'set.notice.set', tone: 'success' } }, dialog: null } },
    { id: 'set-empty', label: 'No reminder on this record', model: { set: set([]), dialog: null }, note: 'Only the Remind me button.' },
    { id: 'set-loading', label: 'Loading', model: { set: { reminders: { status: 'loading' }, held: null, notice: null }, dialog: null } },
    { id: 'set-error', label: 'Could not load', model: { set: { reminders: { status: 'error', problem: 'remind.problem.read' }, held: null, notice: null }, dialog: null } },
  ],
})
