import { defineDesignScreen } from '../../../lib/design/design-screen'
import { RemindMeCase, type RemindMeCaseModel } from './view/RemindMeCase'

/**
 * SCR-543 — Remind me (B-W2b-388; design shell.panels popup remind-me; COL-041). B-TH-280: the old record panels' side panel
 * "Reminders I set" went with them (the docked thread's Head says the next reminder; Home › Tasks lists them all). Made-up data
 * only. The pop-up's choices are worked out from 13 Nov 2026 09:30 in Rome (a Friday): later today 16:00, tomorrow, Monday.
 */

const NOW = Date.UTC(2026, 10, 13, 8, 30)
const id = (n: number) => `0190f0e2-aaaa-7000-8000-${String(n).padStart(12, '0')}`
const RECORD = { type: 'PurchaseOrder', id: id(1), label: 'PO-2026-0031' }

const dialog = { what: RECORD.label, aboutMessage: false, now: NOW, held: null, problem: null }

export const designScreen = defineDesignScreen<RemindMeCaseModel>({
  screen: 'SCR-543',
  title: 'Remind me (B-W2b-388)',
  view: RemindMeCase,
  part: true,
  cases: [
    { id: 'dialog', label: 'Remind me (the record)', model: { dialog }, note: 'Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date · When something changes; my note first (optional). ↑ / ↓ between the choices, Enter sets.' },
    { id: 'dialog-message', label: 'Remind me (a message)', model: { dialog: { ...dialog, aboutMessage: true } }, note: 'Opened from a message of the record’s conversation: the reminder opens the record at the message.' },
    { id: 'dialog-offline', label: 'Remind me offline', model: { dialog: { ...dialog, held: 'remind.held.offline' } }, note: 'Every choice held with the reason; nothing is lost.' },
    { id: 'dialog-problem', label: 'Remind me refused', model: { dialog: { ...dialog, problem: 'remind.problem.tooMany' } }, note: 'The API’s refusal in words above the choices (500 open reminders).' },
  ],
})
