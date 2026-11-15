import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Reminder } from '../../../../shell/panels/remind-me/api'
import type { ReminderRow, RemindersModel } from './model'
import { RemindersView } from './view/RemindersView'

/**
 * SCR-544 — Home › My tasks › Reminders (B-W2b-388; design home.tasks section reminders; COL-041). Made-up data only.
 */

const NOW = Date.UTC(2026, 10, 13, 8, 30)
const id = (n: number) => `0190f0e2-bbbb-7000-8000-${String(n).padStart(12, '0')}`
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()

function row(n: number, record: { type: string; label: string }, extra: Partial<Reminder>): ReminderRow {
  const recordId = id(n)
  return {
    id: id(100 + n),
    record: { type: record.type, id: recordId, label: record.label },
    companyId: id(900),
    messageId: null,
    kind: 'AT_TIME',
    remindAt: at(23.5),
    since: at(-26),
    note: null,
    cameBackAt: null,
    doneAt: null,
    state: 'WAITING',
    version: 1,
    createdAt: at(-26),
    href: `/w/DEMO/records/${record.type}/${recordId}`,
    ...extra,
  }
}

const ROWS: ReminderRow[] = [
  row(1, { type: 'PurchaseOrder', label: 'PO-2026-0031' }, { note: 'Supplier promised a date', state: 'CAME_BACK', remindAt: at(-0.5), cameBackAt: at(-0.5) }),
  row(2, { type: 'SalesOrder', label: 'SO-2026-0047' }, { kind: 'ON_CHANGE', remindAt: null, state: 'CAME_BACK', cameBackAt: at(-2), note: 'When the club confirms the sizes' }),
  row(3, { type: 'Quote', label: 'Q-2026-0142' }, { note: 'Call back about the margin', remindAt: at(23.5) }),
  row(4, { type: 'PurchaseOrder', label: 'PO-2026-0036' }, { kind: 'ON_CHANGE', remindAt: null, messageId: id(55), note: 'Their answer about the lining' }),
  row(5, { type: 'Lot', label: 'LOT-A-000214' }, { remindAt: at(71.5) }),
]
const DONE: ReminderRow[] = [
  row(6, { type: 'Shipment', label: 'SH-2026-0012' }, { state: 'DONE', doneAt: at(-20), cameBackAt: at(-30), remindAt: at(-30), version: 3 }),
  row(7, { type: 'Inquiry', label: 'INQ-2026-0009' }, { state: 'DONE', doneAt: at(-48), kind: 'ON_CHANGE', remindAt: null, version: 2, note: 'Did they send the drawing?' }),
]

const counts = { waiting: 3, cameBack: 2, done: 2 }
const ready = (rows: readonly ReminderRow[]): RemindersModel['list'] => ({ status: 'ready', data: { rows, counts, asOf: at(-0.05), complete: true } })
const base: RemindersModel = { view: 'OPEN', list: ready(ROWS), selected: [], now: NOW, held: null, notice: null, putOff: null }

export const designScreen = defineDesignScreen<RemindersModel>({
  screen: 'SCR-544',
  title: 'My tasks › Reminders (B-W2b-388)',
  view: RemindersView,
  cases: [
    {
      id: 'open',
      label: 'Open reminders (came back first)',
      model: base,
      note: 'The shared list frame: the record as a link, my note (one about a message says so), when it comes back or that it came back, the state; ⋯ Done · Snooze · Remove. Open · Came back · Waiting · Done with counts.',
    },
    { id: 'came-back', label: 'Came back', model: { ...base, view: 'CAME_BACK', list: ready(ROWS.filter((entry) => entry.state === 'CAME_BACK')) } },
    { id: 'done', label: 'Done, with Undo', model: { ...base, view: 'DONE', list: ready(DONE), notice: { key: 'reminders.notice.done', tone: 'success', params: { record: 'SH-2026-0012' }, undo: true } }, note: 'A done reminder offers Undo (⋯ and the notice).' },
    { id: 'selected', label: 'Two selected', model: { ...base, selected: [ROWS[0]!.id, ROWS[2]!.id] }, note: 'Done 2 · Remove 2 (all or none).' },
    { id: 'put-off', label: 'Snooze a reminder', model: { ...base, putOff: ROWS[0]!.id }, note: 'Today’s "Snooze until" choices, with "When something changes"; up to a year ahead.' },
    { id: 'offline', label: 'Offline', model: { ...base, held: 'held.offline' }, note: 'Rows readable; every change held with the reason.' },
    { id: 'empty', label: 'No reminders', model: { ...base, list: { status: 'ready', data: { rows: [], counts: { waiting: 0, cameBack: 0, done: 0 }, asOf: at(-0.05), complete: true } } }, note: '"No reminders." and how to set one.' },
    { id: 'loading', label: 'Loading', model: { ...base, list: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, list: { status: 'error', problem: 'remind.problem.read' } } },
  ],
})
