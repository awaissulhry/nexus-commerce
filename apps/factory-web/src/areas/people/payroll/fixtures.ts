import { createElement } from 'react'
import type { ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX, TODAY, type PeopleRole } from '../_shared/fixtures'
import type { Loaded } from '../_shared/parts'
import { CODES, EXPORTS, LAYOUT_CONFIRMED, LAYOUT_CSV, LAYOUT_ZUCCHETTI, LAYOUTS, MONTH, MONTH_EXPORTED, MONTH_HELD, MONTH_OPEN, MONTH_PENDING, monthOf, RECORD, SHOW_CODES, SHOW_PEOPLE, VALUES, VALUES_CORRECTION, VALUES_NO_PAY } from './demo/fixtures'
import type { Layout, PayrollMonth } from './api'
import { columnsDraftOf, payrollAddressOf, payrollCan, sendDraftOf, wizardHref, type Step } from './model'
import { MAKING_IDLE, PREVIEW_IDLE, type PayrollModel, type WizardModel } from './view-model'
import { PayrollView } from './view/PayrollView'

/**
 * SCR-159 — Payroll export with made-up data only: Exports (states, updates, selected, keys), the band's three pills, the five steps
 * and each one's held states, Show me (people, codes), the mapping's marks, the preview with and without amounts and with from → to,
 * the format with a layout nobody confirmed, a file made, the three pop-ups and their refusals, the gate off, and the roles (HR
 * with the pay grain, the admin template without it, read-only, no right).
 */

/** The admin template holds the three rights; HR is a custom role with the pay grain (the owner's has it too). */
const ROLES = {
  hr: [...PEOPLE_ROLES.hr, 'money.pay'],
  admin: [...PEOPLE_ROLES.hr],
  readOnly: [...PEOPLE_ROLES.readOnly],
  sales: [...PEOPLE_ROLES.sales],
} as const
type Role = keyof typeof ROLES

interface PayrollCase {
  role: Role
  page: PayrollModel
}

const pages: ReadonlySet<string> = new Set(['/people/employees', '/production/labour', '/people/attendance', '/people/piecerates'])

function page(role: Role, month: PayrollMonth | null, over: Partial<PayrollModel> = {}, layout: Layout | null = LAYOUT_CSV): PayrollCase {
  return {
    role,
    page: {
      prefix: PREFIX,
      can: payrollCan(ROLES[role]),
      today: TODAY,
      address: payrollAddressOf(new URLSearchParams()),
      live: 'live',
      asOf: '2026-11-02T09:42:00.000Z',
      month: month ? { status: 'ready', value: month } : { status: 'loading' },
      layouts: { status: 'ready', value: LAYOUTS },
      layout,
      exports: { rows: EXPORTS, more: false, problem: null, slow: false, updates: 0 },
      wizard: null,
      show: null,
      columns: null,
      confirm: null,
      dialogs: { send: null, correct: null, cancel: null },
      notice: null,
      pages,
      ...over,
    },
  }
}

function wizard(step: Step, role: Role, month: PayrollMonth | null, over: Partial<WizardModel> = {}, extra: Partial<PayrollModel> = {}, layout: Layout | null = LAYOUT_CSV): PayrollCase {
  const terms = new URL(wizardHref(PREFIX, month?.month ?? '2026-10', step), 'https://factory.example').searchParams
  return page(role, month, { address: payrollAddressOf(terms), wizard: { step, heldNote: null, codes: { status: 'ready', value: { rows: CODES, unmapped: 2 } }, marks: {}, preview: PREVIEW_IDLE, onlyChanged: false, note: '', making: MAKING_IDLE, record: null, ...over }, ...extra }, layout)
}

const ready = <T,>(value: T): Loaded<T> => ({ status: 'ready', value })
const target = EXPORTS[0]!
const unconfirmedTarget = EXPORTS[2]!
const send = (over: Partial<NonNullable<PayrollModel['dialogs']['send']>> = {}): PayrollModel['dialogs'] => ({ send: { target, draft: sendDraftOf('it', 'studio@example.com'), busy: false, problem: null, done: null, withdrawing: false, withdrawn: false, ...over }, correct: null, cancel: null })
const correct = (over: Partial<NonNullable<PayrollModel['dialogs']['correct']>> = {}): PayrollModel['dialogs'] => ({ send: null, correct: { target, month: MONTH_PENDING, readProblem: null, busy: false, startedAt: null, problem: null, changes: PREVIEW_IDLE, done: null, ...over }, cancel: null })
const SENT = { link: { id: 'l1', email: 'studio@example.com', expiresAt: '2026-11-09T09:00:00.000Z', maxUses: 10 }, withdrawn: [], delivery: 'SENT' }

function PayrollDesign({ model }: { model: PayrollCase }): ReactNode {
  const role: PeopleRole = model.role === 'hr' || model.role === 'admin' ? 'hr' : model.role
  return inShell('/people/payroll', createElement(PayrollView, { model: model.page }), role)
}

export const designScreen = defineDesignScreen<PayrollCase>({
  screen: 'SCR-159',
  title: 'Payroll export',
  view: PayrollDesign,
  holdsPage: true,
  cases: [
    { id: 'list', label: 'Exports: October not exported, the band, every state of a file', model: page('hr', MONTH) },
    { id: 'list-selected', label: 'Two rows selected: Export 2 as CSV', model: page('hr', MONTH, { selected: [EXPORTS[0]!.id, EXPORTS[2]!.id] }) },
    { id: 'list-exported', label: 'The month is exported: the band opens v2', model: page('hr', MONTH_EXPORTED) },
    { id: 'list-pending', label: 'Correction pending: the band says what differs and offers the correction', model: page('hr', MONTH_PENDING) },
    { id: 'list-updates', label: 'Someone made or sent a file: N updates · Show', model: page('hr', MONTH, { exports: { rows: EXPORTS, more: false, problem: null, slow: false, updates: 2 } }) },
    { id: 'list-more', label: 'More exports than a page: Show more', model: page('hr', MONTH, { exports: { rows: EXPORTS, more: true, problem: null, slow: false, updates: 0 } }) },
    { id: 'list-empty', label: 'No export yet', model: page('hr', MONTH, { exports: { rows: [], more: false, problem: null, slow: false, updates: 0 } }) },
    { id: 'list-no-match', label: 'No export in that year', model: page('hr', MONTH, { address: payrollAddressOf(new URLSearchParams('year=2024')), exports: { rows: [], more: false, problem: null, slow: false, updates: 0 } }) },
    { id: 'list-loading', label: 'Loading: the list and the band', model: page('hr', null, { exports: { rows: null, more: false, problem: null, slow: true, updates: 0 }, asOf: null, live: 'connecting' }) },
    { id: 'list-error', label: "The exports couldn't be read", model: page('hr', MONTH, { exports: { rows: null, more: false, problem: 'problem.unavailable', slow: false, updates: 0 } }) },
    { id: 'month-error', label: "The month couldn't be read: held with why", model: page('hr', null, { month: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'gate-off', label: 'Attendance off at every site: nothing is read, past exports stay', model: page('hr', null, { month: { status: 'error', problem: 'problem.gate' } }) },
    { id: 'keys', label: 'The keys, in the footer icon', model: page('hr', MONTH, { keysOpen: true }) },
    { id: 'help', label: 'Keyboard shortcuts', model: page('hr', MONTH, { help: true }) },
    { id: 'read-only', label: 'Read-only: sees states and counts, held with why', model: page('readOnly', MONTH) },
    { id: 'no-right', label: 'Sales: no right', model: page('sales', MONTH) },

    { id: 'period', label: '1 · Period and company: closed', model: wizard('period', 'hr', MONTH) },
    { id: 'period-open', label: '1 · Continue held: October is not closed · Close it in Attendance', model: wizard('period', 'hr', MONTH_OPEN) },
    { id: 'period-page-missing', label: '1 · The Attendance page not built yet: said in words', model: wizard('period', 'hr', MONTH_OPEN, {}, { pages: new Set() }) },
    { id: 'period-correction', label: '1 · A month with a file: a new one is a correction', model: wizard('period', 'hr', MONTH_PENDING) },
    { id: 'period-unconfirmed', label: '1 · A provider format nobody confirmed: the warning', model: wizard('period', 'hr', MONTH, {}, {}, LAYOUT_ZUCCHETTI) },
    { id: 'period-loading', label: '1 · Loading', model: wizard('period', 'hr', null) },
    { id: 'period-error', label: "1 · The month couldn't be read", model: wizard('period', 'hr', null, {}, { month: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'gate-wizard', label: 'The wizard with attendance off', model: wizard('period', 'hr', null, {}, { month: { status: 'error', problem: 'problem.gate' } }) },

    { id: 'checks', label: '2 · Checks: blocking ones pass, two warnings', model: wizard('checks', 'hr', MONTH) },
    { id: 'checks-held', label: '2 · Four blocking checks: Continue held with the count, Show me', model: wizard('checks', 'hr', MONTH_HELD) },
    { id: 'checks-no-right', label: '2 · Show me held: the admin without people.payroll.records (read-only here)', model: wizard('checks', 'readOnly', MONTH_HELD) },
    { id: 'checks-unconfirmed', label: '2 · A provider format nobody confirmed: the warning', model: wizard('checks', 'hr', monthOf({ checks: MONTH.checks.map((check) => (check.code === 'LAYOUT_NOT_CONFIRMED' ? { ...check, passed: false, count: 1 } : check)) }), {}, {}, LAYOUT_ZUCCHETTI) },
    { id: 'show-people', label: 'Show me: the people, recorded, their names in this window alone', model: wizard('checks', 'hr', MONTH_HELD, {}, { show: { check: MONTH_HELD.checks.find((check) => check.code === 'EMPLOYEE_CODES')!, answer: SHOW_PEOPLE, problem: null } }) },
    { id: 'show-codes', label: 'Show me: the codes with no provider code', model: wizard('checks', 'hr', MONTH_HELD, {}, { show: { check: MONTH_HELD.checks.find((check) => check.code === 'CODES_MAPPED')!, answer: SHOW_CODES, problem: null } }) },
    { id: 'show-refused', label: 'Show me refused', model: wizard('checks', 'hr', MONTH_HELD, {}, { show: { check: MONTH_HELD.checks.find((check) => check.code === 'EMPLOYEE_CODES')!, answer: null, problem: { key: 'problem.forbidden' } } }) },

    { id: 'mapping', label: '3 · Code mapping: unmapped rows first', model: wizard('mapping', 'hr', MONTH) },
    { id: 'mapping-marks', label: '3 · A code saving, one saved, one refused', model: wizard('mapping', 'hr', MONTH, { marks: { 'ABSENCE|FERIE': { state: 'saving' }, 'HOUR|ORD': { state: 'saved' }, 'EARNING|TEAM_SHARE': { state: 'failed', words: { key: 'problem.conflict' } } } }) },
    { id: 'mapping-read-only', label: '3 · Read-only: the codes, no edit', model: wizard('mapping', 'readOnly', MONTH) },
    { id: 'mapping-loading', label: '3 · Loading', model: wizard('mapping', 'hr', MONTH, { codes: { status: 'loading' } }) },
    { id: 'mapping-error', label: "3 · The codes couldn't be read", model: wizard('mapping', 'hr', MONTH, { codes: { status: 'error', problem: 'problem.unavailable' } }) },

    { id: 'preview-closed', label: '4 · The numbers closed: they open on a click, recorded', model: wizard('preview', 'hr', MONTH) },
    { id: 'preview', label: '4 · Preview per employee code, with the amounts', model: wizard('preview', 'hr', MONTH, { preview: { status: 'ready', value: VALUES, problem: null } }) },
    { id: 'preview-no-pay', label: '4 · Without the pay grain: no money column', model: wizard('preview', 'admin', MONTH, { preview: { status: 'ready', value: VALUES_NO_PAY, problem: null } }) },
    { id: 'preview-correction', label: '4 · A correction: changed cells from → to', model: wizard('preview', 'hr', MONTH_PENDING, { preview: { status: 'ready', value: VALUES_CORRECTION, problem: null } }) },
    { id: 'preview-changed', label: '4 · Filter to changed rows', model: wizard('preview', 'hr', MONTH_PENDING, { preview: { status: 'ready', value: VALUES_CORRECTION, problem: null }, onlyChanged: true }) },
    { id: 'preview-no-right', label: '4 · Without people.payroll.records', model: wizard('preview', 'readOnly', MONTH) },
    { id: 'preview-reading', label: '4 · Loading', model: wizard('preview', 'hr', MONTH, { preview: { status: 'reading', value: null, problem: null } }) },
    { id: 'preview-error', label: "4 · The numbers couldn't be opened", model: wizard('preview', 'hr', MONTH, { preview: { status: 'error', value: null, problem: { key: 'problem.forbidden' } } }) },

    { id: 'send', label: '5 · Format chosen: make the file', model: wizard('send', 'hr', MONTH) },
    { id: 'send-unconfirmed', label: '5 · Zucchetti starter: not confirmed, what the consultant must confirm', model: wizard('send', 'hr', MONTH, {}, {}, LAYOUT_ZUCCHETTI) },
    { id: 'send-confirmed', label: '5 · A provider format confirmed', model: wizard('send', 'hr', MONTH, {}, { layouts: ready({ ...LAYOUTS, layouts: [LAYOUT_CSV, LAYOUT_CONFIRMED] }) }, LAYOUT_CONFIRMED) },
    { id: 'send-making', label: '5 · Making the file', model: wizard('send', 'hr', MONTH, { making: { busy: true, startedAt: Date.parse('2026-11-02T09:41:50.000Z'), problem: null } }) },
    { id: 'send-refused', label: '5 · Refused: a blocking check came back', model: wizard('send', 'hr', MONTH, { making: { busy: false, startedAt: null, problem: { key: 'refusal.CHECKS_OPEN', params: { count: 2 } } } }) },
    { id: 'send-held-pay', label: '5 · The admin without the pay grain: held with why', model: wizard('send', 'admin', MONTH) },
    { id: 'send-held-manage', label: '5 · Read-only: held with why', model: wizard('send', 'readOnly', MONTH) },
    { id: 'send-no-format', label: '5 · No format yet', model: wizard('send', 'hr', MONTH, {}, { layouts: ready({ ...LAYOUTS, layouts: [] }) }, null) },
    { id: 'send-done', label: '5 · The file made: seal, two files, Send, Done', model: wizard('send', 'hr', MONTH_EXPORTED, { record: ready(RECORD) }) },
    { id: 'send-pending', label: '5 · Correction pending on the file', model: wizard('send', 'hr', MONTH_PENDING, { record: ready(RECORD) }) },
    { id: 'send-record-loading', label: "5 · Reading the month's file", model: wizard('send', 'hr', MONTH_EXPORTED, { record: { status: 'loading' } }) },
    { id: 'send-record-error', label: "5 · The month's file couldn't be read", model: wizard('send', 'hr', MONTH_EXPORTED, { record: { status: 'error', problem: 'problem.unavailable' } }) },

    { id: 'columns', label: 'CSV columns', model: wizard('send', 'hr', MONTH, {}, { columns: { layout: LAYOUT_CSV, draft: columnsDraftOf(LAYOUT_CSV), busy: false, problem: null } }) },
    { id: 'columns-fixed', label: 'File columns of a fixed-width format: widths', model: wizard('send', 'hr', MONTH, {}, { columns: { layout: LAYOUT_ZUCCHETTI, draft: columnsDraftOf(LAYOUT_ZUCCHETTI), busy: false, problem: null } }, LAYOUT_ZUCCHETTI) },
    { id: 'columns-held', label: 'CSV columns: Save held with the first problem', model: wizard('send', 'hr', MONTH, {}, { columns: { layout: LAYOUT_CSV, draft: { ...columnsDraftOf(LAYOUT_CSV), name: '' }, busy: false, problem: null } }) },
    { id: 'columns-refused', label: 'CSV columns refused: a name taken', model: wizard('send', 'hr', MONTH, {}, { columns: { layout: LAYOUT_CSV, draft: columnsDraftOf(LAYOUT_CSV), busy: false, problem: { key: 'refusal.NAME_TAKEN' } } }) },
    { id: 'confirm', label: "The consultant's confirmation", model: wizard('send', 'hr', MONTH, {}, { confirm: { layout: LAYOUT_ZUCCHETTI, draft: { by: '', on: TODAY }, busy: false, problem: null } }, LAYOUT_ZUCCHETTI) },
    { id: 'confirm-back', label: 'A confirmation can be taken back', model: wizard('send', 'hr', MONTH, {}, { confirm: { layout: LAYOUT_CONFIRMED, draft: { by: 'Studio Demo', on: '2026-10-20' }, busy: false, problem: null } }, LAYOUT_CONFIRMED) },

    { id: 'send-dialog', label: 'Send to the labour consultant: it says a browser cannot fetch the file yet', model: page('hr', MONTH_EXPORTED, { dialogs: send() }) },
    { id: 'send-dialog-empty', label: 'Send held: no address', model: page('hr', MONTH_EXPORTED, { dialogs: send({ draft: sendDraftOf('it') }) }) },
    { id: 'send-dialog-unconfirmed', label: 'Send with a layout nobody confirmed', model: page('hr', MONTH_EXPORTED, { dialogs: { ...send(), send: { ...send().send!, target: unconfirmedTarget } } }) },
    { id: 'send-dialog-refused', label: 'Send refused: an address that does not take our mail', model: page('hr', MONTH_EXPORTED, { dialogs: send({ problem: { key: 'refusal.SUPPRESSED' } }) }) },
    { id: 'send-dialog-done', label: 'Sent: the result, the link can be withdrawn', model: page('hr', MONTH_EXPORTED, { dialogs: send({ done: SENT }) }) },
    { id: 'send-dialog-failed', label: 'The mail failed', model: page('hr', MONTH_EXPORTED, { dialogs: send({ done: { ...SENT, delivery: 'FAILED' } }) }) },
    { id: 'send-dialog-withdrawn', label: 'The link withdrawn', model: page('hr', MONTH_EXPORTED, { dialogs: send({ done: SENT, withdrawn: true }) }) },
    { id: 'correct', label: 'Make correction export: what changed in counts', model: page('hr', MONTH_PENDING, { dialogs: correct() }) },
    { id: 'correct-changes', label: 'Make correction export: from → to, opened and recorded', model: page('hr', MONTH_PENDING, { dialogs: correct({ changes: { status: 'ready', value: VALUES_CORRECTION, problem: null } }) }) },
    { id: 'correct-held', label: 'Make correction export held: nothing changed', model: page('hr', MONTH_EXPORTED, { dialogs: correct({ month: MONTH_EXPORTED }) }) },
    { id: 'correct-making', label: 'Making the correction', model: page('hr', MONTH_PENDING, { dialogs: correct({ busy: true, startedAt: Date.parse('2026-11-02T09:41:50.000Z') }) }) },
    { id: 'correct-done', label: 'v3 made: Send', model: page('hr', MONTH_PENDING, { dialogs: correct({ done: { ...RECORD, revision: 3, number: 'PAY-2026-0011' } }) }) },
    { id: 'cancel', label: 'Cancel a draft: the reason', model: page('hr', MONTH, { dialogs: { send: null, correct: null, cancel: { target: EXPORTS[3]!, reason: '', busy: false, problem: null } } }) },
  ],
})
