import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { AGEING, canAs, GAMMA, inShell, NOW, PREFIX, REMINDERS, ROWS, STATEMENT, SWITCH_OFF, SWITCH_ON, TODAY, withoutPrice, type Role } from './demo/fixtures'
import { addressOf, rowStatement, statementKey } from './model'
import { ReceivablesView, type ReceivablesModel } from './view/ReceivablesView'

/**
 * SCR-151 — Finance › Receivables & credit (design finance.receivables) with made-up data only: What customers owe (the
 * six tiles; a tile pressed filters the table), By customer (the AgeBar; selected rows → Print N statements · Export N),
 * Reminders to approve (switch off: Approve n, they wait; switch on: Approve and send n; a call held in bulk), the
 * statement DetailModal (pop:statement: the bridge, the movements, what is open; the send step), the reminder dialog
 * (text, warnings, Edit text, Skip with reason, the call note), and the states (loading with "Still loading…", error,
 * empty, nothing matching, offline, refusals in words) and roles: Finance and Owner (everything), Sales (reads, never a
 * reminder move — B-W2a-81), Read-only (no price grain: counts and dates, no amount, no text), Warehouse (no access).
 */

interface Case {
  role: Role
  page: ReceivablesModel
}

const ADDRESS = addressOf(null)

const base = (role: Role, over: Partial<ReceivablesModel> = {}): Case => {
  const can = canAs(role)
  const priced = can.price
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      address: ADDRESS,
      ageing: {
        value: priced ? AGEING : withoutPrice(AGEING),
        problem: null,
        slow: false,
      },
      rows: priced ? ROWS : withoutPrice(ROWS),
      more: false,
      readAt: NOW - 60_000,
      live: 'live',
      updates: 0,
      counts: { toApprove: 3, waiting: 1, sent30Days: 6 },
      reminders: {
        value: priced ? REMINDERS : withoutPrice(REMINDERS),
        problem: null,
        more: false,
      },
      settings: SWITCH_OFF,
      statement: null,
      reminder: null,
      busy: false,
      notice: null,
      ...over,
    },
  }
}

function ReceivablesDesign({ model }: { model: Case }) {
  return inShell('/finance/receivables', createElement(ReceivablesView, { model: model.page }), model.role)
}

const gamma = ROWS[0]!
const statementOpen = (role: Role, over: Partial<NonNullable<ReceivablesModel['statement']>> = {}): Partial<ReceivablesModel> => ({
  address: {
    ...ADDRESS,
    statement: GAMMA.id,
    company: gamma.company.id,
    currency: 'EUR',
  },
  statement: {
    ref: rowStatement(gamma),
    period: { from: null, to: null },
    value: canAs(role).price ? STATEMENT : withoutPrice(STATEMENT),
    problem: null,
    ...over,
  },
})
const reminderOpen = (index: number, role: Role, over: Partial<NonNullable<ReceivablesModel['reminder']>> = {}): Partial<ReceivablesModel> => ({
  address: { ...ADDRESS, reminder: REMINDERS[index]!.id },
  reminder: {
    id: REMINDERS[index]!.id,
    value: canAs(role).price ? REMINDERS[index]! : withoutPrice(REMINDERS[index]!),
    problem: null,
    ...over,
  },
})

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-151',
  title: 'Receivables & reminders: what customers owe by age, statements, reminders a person approves',
  view: ReceivablesDesign,
  cases: [
    {
      id: 'finance',
      label: 'Finance · what customers owe, by customer, reminders to approve (switch off)',
      model: base('finance'),
      note: 'Open 23,180.00 = 12,200.00 + 8,540.00 + 1,830.00 + 610.00; overdue 15,250.00; the six tiles add up to the open amount.',
    },
    {
      id: 'owner',
      label: 'Owner · the same page, reminders switched on: Approve and send',
      model: base('owner', { settings: SWITCH_ON }),
    },
    {
      id: 'tile',
      label: 'Tile "Overdue" pressed: only customers with money late',
      model: base('finance', {
        address: { ...ADDRESS, bucket: 'OVERDUE' },
        rows: ROWS.filter((row) => (row.overdue ?? 0) > 0),
      }),
    },
    {
      id: 'tile-90',
      label: 'Tile "Over 90 days" pressed',
      model: base('finance', {
        address: { ...ADDRESS, bucket: 'OVER_90' },
        rows: ROWS.filter((row) => (row.buckets?.OVER_90 ?? 0) > 0),
      }),
    },
    {
      id: 'as-of',
      label: 'As of 30 September 2026',
      model: base('finance', { address: { ...ADDRESS, asOf: '2026-09-30' } }),
    },
    {
      id: 'selected',
      label: 'Two customers chosen · Print 2 statements · Export 2',
      model: base('finance', {
        selected: [statementKey(rowStatement(ROWS[0]!)), statementKey(rowStatement(ROWS[1]!))],
      }),
    },
    {
      id: 'reminders-selected',
      label: 'Two reminders chosen · Approve 2 (switch off: they wait)',
      model: base('finance', {
        selectedReminders: [REMINDERS[0]!.id, REMINDERS[1]!.id],
      }),
    },
    {
      id: 'reminders-selected-on',
      label: 'Switch on · a call among the chosen: held in bulk, in words',
      model: base('owner', {
        settings: SWITCH_ON,
        selectedReminders: REMINDERS.map((entry) => entry.id),
      }),
    },
    {
      id: 'statement',
      label: 'Gamma Demo — statement: opening + invoices − payments = balance; J / K',
      model: base('finance', statementOpen('finance')),
      note: 'Invoices 17,080.00 − payments 4,880.00 = closing 12,200.00; open: 6,100.00 (61 days late) + 3,660.00 (1 day) + 2,440.00 (not due).',
    },
    {
      id: 'statement-send',
      label: 'Send statement: who it goes to, a message',
      model: base('finance', statementOpen('finance', { sending: true })),
    },
    {
      id: 'statement-send-failed',
      label: 'Send statement refused: the reason in words',
      model: base(
        'finance',
        statementOpen('finance', {
          sending: true,
          sendProblem: 'problem.unavailable',
        }),
      ),
    },
    {
      id: 'statement-loading',
      label: 'The statement reading',
      model: base('finance', statementOpen('finance', { value: null })),
    },
    {
      id: 'statement-error',
      label: "The statement couldn't load: Try again",
      model: base(
        'finance',
        statementOpen('finance', {
          value: null,
          problem: 'problem.unavailable',
        }),
      ),
    },
    {
      id: 'statement-read-only',
      label: 'Read-only · the statement without amounts; Print and Send held (price grain)',
      model: base('readOnly', statementOpen('readOnly')),
    },
    {
      id: 'reminder',
      label: 'A reminder: a letter, 30 days late, a warning (payment being processed)',
      model: base('finance', reminderOpen(0, 'finance')),
    },
    {
      id: 'reminder-edit',
      label: "Edit text in the customer's language",
      model: base('finance', reminderOpen(1, 'finance', { step: 'edit' })),
    },
    {
      id: 'reminder-skip',
      label: 'Skip with reason',
      model: base('finance', reminderOpen(1, 'finance', { step: 'skip' })),
    },
    {
      id: 'reminder-changed',
      label: 'Approve refused: paid or credited since it was prepared (in words); Cancel reminder',
      model: base('finance', reminderOpen(0, 'finance', { actionProblem: 'refusal.CHANGED' })),
    },
    {
      id: 'reminder-cancel',
      label: 'Cancel reminder with reason (the ladder prepares it again)',
      model: base('finance', reminderOpen(0, 'finance', { step: 'cancel' })),
    },
    {
      id: 'reminder-call',
      label: 'Switch on · a call: recorded with what was said',
      model: base('owner', {
        settings: SWITCH_ON,
        ...reminderOpen(2, 'owner', { step: 'call' }),
      }),
    },
    {
      id: 'reminder-refused',
      label: 'Approve and send refused: switched off (in words)',
      model: base('owner', {
        settings: SWITCH_ON,
        ...reminderOpen(1, 'owner', { actionProblem: 'refusal.SWITCHED_OFF' }),
      }),
    },
    {
      id: 'bulk-refused',
      label: 'Approve 2 refused: none approved, each reason in words',
      model: base('finance', {
        notice: {
          tone: 'danger',
          words: { key: 'notice.noneApproved' },
          items: [
            { name: 'Moto Demo S.r.l.', words: { key: 'refusal.CHANGED' } },
            { name: 'Gamma Demo S.n.c.', words: { key: 'problem.conflict' } },
          ],
        },
      }),
    },
    {
      id: 'approved',
      label: 'Two reminders approved: they wait for the switch',
      model: base('finance', {
        notice: {
          tone: 'success',
          words: { key: 'notice.approvedWaiting', params: { count: 2 } },
        },
      }),
    },
    {
      id: 'updates',
      label: 'Live · 2 payments since the read',
      model: base('finance', { updates: 2 }),
    },
    {
      id: 'keys',
      label: 'Keys in the footer info icon',
      model: base('finance', { keysOpen: true, focusRow: 0 }),
    },
    {
      id: 'sales',
      label: 'Sales · reads what customers owe; reminders held (no approve permission)',
      model: base('sales'),
    },
    {
      id: 'read-only',
      label: 'Read-only · no price grain: counts and dates, no amount, no text',
      model: base('readOnly'),
    },
    {
      id: 'empty',
      label: 'Nobody owes anything (tiles 0, never "—")',
      model: base('finance', {
        ageing: {
          value: { ...AGEING, tiles: [], customers: [], count: 0 },
          problem: null,
          slow: false,
        },
        rows: [],
        counts: { toApprove: 0, waiting: 0, sent30Days: 0 },
        reminders: { value: [], problem: null, more: false },
      }),
    },
    {
      id: 'no-match',
      label: 'Nothing matches the search',
      model: base('finance', { address: { ...ADDRESS, q: 'ZZZ' }, rows: [] }),
    },
    {
      id: 'loading',
      label: 'Loading · "Still loading…" after a second',
      model: base('finance', {
        ageing: { value: null, problem: null, slow: true },
        rows: null,
        readAt: null,
        counts: null,
        reminders: { value: null, problem: null, more: false },
        settings: null,
      }),
    },
    {
      id: 'error',
      label: "Error · couldn't load, Try again (never drawn as empty)",
      model: base('finance', {
        ageing: { value: null, problem: 'problem.unavailable', slow: false },
        rows: null,
        readAt: null,
        reminders: { value: null, problem: 'problem.unavailable', more: false },
      }),
    },
    {
      id: 'offline',
      label: 'Offline · reading again when back',
      model: base('finance', { live: 'offline' }),
    },
    {
      id: 'no-permission',
      label: 'Warehouse · no receivables.view',
      model: base('warehouse', {
        ageing: { value: null, problem: null, slow: false },
        rows: null,
        readAt: null,
        counts: null,
        reminders: { value: null, problem: null, more: false },
        settings: null,
      }),
    },
  ],
})
