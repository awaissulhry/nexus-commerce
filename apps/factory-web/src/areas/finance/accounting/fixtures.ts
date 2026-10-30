import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../_shared/hooks'
import {
  ADDRESS,
  AUGUST,
  canAs,
  EXPORT_DONE,
  HISTORY,
  inShell,
  INTRASTAT_EMPTY,
  INTRASTAT_OCTOBER,
  LOCK_AUGUST,
  LOCK_SEPTEMBER,
  NOW,
  OCTOBER,
  OCTOBER_FIXED,
  PERIODS_2025,
  PERIODS_2026,
  PREFIX,
  SEPTEMBER,
  TODAY,
  withoutCost,
  type Role,
} from './demo/fixtures'
import { defaultPackages, recentMonths, type WizardStep } from './model'
import { AccountingView } from './view/AccountingView'
import type { AccountingModel, LockDialogModel, LockPanelModel, WizardModel } from './view-model'

/**
 * SCR-156 — Accounting export (design finance.accounting) with made-up data only: the Exports (batches numbered, a
 * re-export, a draft, documents changed since, the band's lock pills), the wizard step by step — 1 · Period (the months
 * with their batches and locks), 2 · Checks (failing with fix links, explained, "2 checks fixed since you opened this"),
 * 3 · Contents (W2b packages and the year-end pack held in words; a role without the cost grain), Intrastat rows (flags
 * with where to fix them; none), 4 · Review (first export; a re-export), 5 · Export and lock (the number it will get,
 * exporting, made, the soft and hard lock with the typed phrase, a refusal, nothing changed) — the lock dialog (lift a
 * soft lock; a final close finance cannot lift), cancelling a draft, the step-up before lifting a final close, and the
 * states (loading, error, empty, offline, no permission) and roles: Finance, Owner, Read only, Sales.
 */

interface Case {
  role: Role
  page: AccountingModel
}

const RECENT = recentMonths(TODAY, [PERIODS_2026, PERIODS_2025])

const lockPanel = (month: string | null, over: Partial<LockPanelModel> = {}): LockPanelModel => ({
  month,
  current: null,
  level: 'SOFT',
  phrase: '',
  note: '',
  busy: false,
  problem: null,
  done: null,
  liftReason: '',
  liftBusy: false,
  liftProblem: null,
  lifted: null,
  ...over,
})

const base = (role: Role, over: Partial<AccountingModel> = {}): Case => ({
  role,
  page: {
    prefix: PREFIX,
    can: canAs(role),
    today: TODAY,
    address: ADDRESS,
    live: 'live',
    now: NOW,
    recent: RECENT,
    history: { rows: HISTORY, more: false, problem: null, slow: false, readAt: NOW - 90_000 },
    updates: 0,
    wizard: null,
    lockDialog: null,
    cancelDialog: null,
    stepUp: STEP_UP_CLOSED,
    notice: null,
    ...over,
  },
})

const wizard = (step: WizardStep, over: Partial<WizardModel> = {}, role: Role = 'finance'): WizardModel => {
  const answer = 'period' in over ? (over.period?.value ?? null) : OCTOBER
  return {
    step,
    month: '2026-10',
    year: 2026,
    periods: { value: PERIODS_2026, problem: null },
    period: { value: answer, problem: null },
    pending: null,
    chosen: answer ? defaultPackages(answer, canAs(role)) : null,
    explanations: {},
    intrastat: { value: INTRASTAT_OCTOBER, problem: null },
    language: 'it',
    note: '',
    exporting: { busy: false, startedAt: null, problem: null, done: null },
    lock: lockPanel('2026-10'),
    heldNote: null,
    ...over,
  }
}

const EXPLAINED = {
  PERIOD_ENDED: 'Anticipo per lo studio: a novembre la riesportazione con il resto del mese.',
  SHIPMENTS_INVOICED: 'I due DDT si fatturano a fine mese (fattura differita).',
  PAYMENTS_PLACED: 'Bonifico in attesa del riferimento del cliente.',
  INTRASTAT_COMPLETE: 'Codice NC da confermare con lo spedizioniere.',
}

const inWizard = (role: Role, step: WizardStep, over: Partial<WizardModel> = {}, page: Partial<AccountingModel> = {}): Case =>
  base(role, { address: { ...ADDRESS, wizard: true, month: over.month === undefined ? '2026-10' : over.month, step }, wizard: wizard(step, over, role), ...page })

const dialog = (month: string | null, over: Partial<LockDialogModel> = {}): LockDialogModel => ({
  ...lockPanel(month),
  months: recentMonths(TODAY, [PERIODS_2026, PERIODS_2025], 12).map((entry) => ({ month: entry.month, state: entry.state })),
  readProblem: null,
  ...over,
})

function AccountingDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting', createElement(AccountingView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-156',
  title: 'Accounting export: numbered batches for the accountant, the export wizard and the period lock',
  view: AccountingDesign,
  cases: [
    // ---- the history ----
    { id: 'finance', label: 'Finance · Exports, the lock pills, a draft, a re-export, documents changed since', model: base('finance'), note: 'September: EXP-2026-0002 amended by EXP-2026-0003, 2 documents changed since → Re-export. August: nothing changed since EXP-2026-0001. October: a draft that did not finish (no files, not selectable).' },
    { id: 'owner', label: 'Owner · the same page', model: base('owner') },
    { id: 'read-only', label: 'Read only · New export and Re-export held with the permission in words', model: base('reader') },
    { id: 'selected', label: 'Two batches chosen · Files of 2 batches', model: base('finance', { selected: [HISTORY[1]!.id, HISTORY[3]!.id] }) },
    { id: 'updates', label: 'Live · a batch made elsewhere: 1 update · Show', model: base('finance', { updates: 1 }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base('finance', { keysOpen: true, focusRow: 1 }) },
    { id: 'empty', label: 'No exports yet · New export', model: base('finance', { history: { rows: [], more: false, problem: null, slow: false, readAt: NOW } }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: base('finance', { recent: null, history: { rows: null, more: false, problem: null, slow: true, readAt: null } }) },
    { id: 'error', label: "Error · couldn't load the exports, Try again", model: base('finance', { history: { rows: null, more: false, problem: 'problem.read.unavailable', slow: false, readAt: null } }) },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'cancel-draft', label: 'Cancel the draft of October (reason asked)', model: base('finance', { cancelDialog: { row: HISTORY[0]!, reason: '', busy: false, problem: null } }) },
    { id: 'notice', label: 'The draft is cancelled (notice)', model: base('finance', { notice: { key: 'notice.cancelled', params: { month: 'October 2026' } } }) },
    { id: 'no-permission', label: 'Sales · no accounting permission', model: base('sales', { recent: null, history: { rows: null, more: false, problem: null, slow: false, readAt: null } }) },
    // ---- 1 · Period ----
    { id: 'period', label: '1 · Period · the months of 2026 with their batches and locks', model: inWizard('finance', 'period', { month: null, period: { value: null, problem: null }, chosen: null }) },
    { id: 'period-chosen', label: '1 · Period · October chosen: first export, not over, a draft it replaces', model: inWizard('finance', 'period') },
    { id: 'period-reexport', label: '1 · Period · September: a re-export of EXP-2026-0003 (3 documents)', model: inWizard('finance', 'period', { month: '2026-09', period: { value: SEPTEMBER, problem: null } }) },
    { id: 'period-loading', label: '1 · Period · reading the months', model: inWizard('finance', 'period', { month: null, periods: { value: null, problem: null }, period: { value: null, problem: null }, chosen: null }) },
    { id: 'period-error', label: "1 · Period · couldn't load", model: inWizard('finance', 'period', { month: null, periods: { value: null, problem: 'problem.read.unavailable' }, period: { value: null, problem: null }, chosen: null }) },
    // ---- 2 · Checks ----
    { id: 'checks', label: '2 · Checks · 4 failing, fix links, Continue held with the count', model: inWizard('finance', 'checks'), note: 'Continue is held "4 checks fail without an explanation"; Show me focuses the first explanation field; ⌘↵ says the reason.' },
    { id: 'checks-explained', label: '2 · Checks · every failing check explained', model: inWizard('finance', 'checks', { explanations: EXPLAINED }) },
    { id: 'checks-live', label: '2 · Checks · "2 checks fixed since you opened this · Check again"', model: inWizard('finance', 'checks', { pending: { fixed: ['SHIPMENTS_INVOICED', 'PAYMENTS_PLACED'], changed: true } }) },
    { id: 'checks-again', label: '2 · Checks · after Check again: 2 still failing', model: inWizard('finance', 'checks', { period: { value: OCTOBER_FIXED, problem: null } }) },
    { id: 'checks-read-only', label: '2 · Checks · Read only: explanations read-only, held in words', model: inWizard('reader', 'checks', {}, {}) },
    { id: 'checks-loading', label: '2 · Checks · reading the month', model: inWizard('finance', 'checks', { period: { value: null, problem: null }, chosen: null }) },
    { id: 'checks-error', label: "2 · Checks · couldn't load, Try again", model: inWizard('finance', 'checks', { period: { value: null, problem: 'problem.read.unavailable' }, chosen: null }) },
    // ---- 3 · Contents ----
    { id: 'contents', label: '3 · Contents · the journals and Intrastat ticked; W2b and the year-end pack held', model: inWizard('finance', 'contents', { explanations: EXPLAINED }) },
    { id: 'contents-no-cost', label: '3 · Contents · without the cost grain: purchases and the year-end pack held', model: inWizard('financePrice', 'contents', { explanations: EXPLAINED, period: { value: withoutCost(OCTOBER), problem: null } }, {}) },
    { id: 'contents-none', label: '3 · Contents · nothing ticked: Continue held', model: inWizard('finance', 'contents', { explanations: EXPLAINED, chosen: [] }) },
    // ---- Intrastat rows ----
    { id: 'intrastat', label: 'Intrastat rows · a 6-digit code (blocking) and no Incoterm (note), with where to fix', model: inWizard('finance', 'intrastat', { explanations: { ...EXPLAINED, INTRASTAT_COMPLETE: '' } }) },
    { id: 'intrastat-explained', label: 'Intrastat rows · the check explained', model: inWizard('finance', 'intrastat', { explanations: EXPLAINED }) },
    { id: 'intrastat-empty', label: 'Intrastat rows · no EU sales this month', model: inWizard('finance', 'intrastat', { explanations: EXPLAINED, intrastat: { value: INTRASTAT_EMPTY, problem: null } }) },
    { id: 'intrastat-loading', label: 'Intrastat rows · reading', model: inWizard('finance', 'intrastat', { explanations: EXPLAINED, intrastat: { value: null, problem: null } }) },
    { id: 'intrastat-error', label: "Intrastat rows · couldn't load", model: inWizard('finance', 'intrastat', { explanations: EXPLAINED, intrastat: { value: null, problem: 'problem.read.unavailable' } }) },
    // ---- 4 · Review ----
    { id: 'review', label: '4 · Review · first export: counts and totals per package', model: inWizard('finance', 'review', { explanations: EXPLAINED }) },
    { id: 'review-reexport', label: '4 · Review · re-export of EXP-2026-0003: 2 documents, Intrastat whole again', model: inWizard('finance', 'review', { month: '2026-09', period: { value: SEPTEMBER, problem: null } }) },
    { id: 'review-held', label: '4 · Review · a check unexplained: Continue held, Show me', model: inWizard('finance', 'review', { explanations: { ...EXPLAINED, PAYMENTS_PLACED: '' } }) },
    // ---- 5 · Export and lock ----
    { id: 'export', label: '5 · Export · the number it will get, the files, Export October 2026 as EXP-2026-0004', model: inWizard('finance', 'export', { explanations: EXPLAINED }) },
    { id: 'export-busy', label: '5 · Export · making the batch (JobProgress)', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: true, startedAt: NOW - 4000, problem: null, done: null } }) },
    { id: 'export-refused', label: '5 · Export · refused: documents changed while it was made', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: false, startedAt: null, problem: { key: 'problem.write.changedWhile', reload: true }, done: null } }) },
    { id: 'export-done', label: '5 · Export · EXP-2026-0004 made: files to download, then the lock', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: false, startedAt: null, problem: null, done: EXPORT_DONE } }) },
    { id: 'export-hard', label: '5 · Lock · hard: the phrase typed wrong, Close held', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: false, startedAt: null, problem: null, done: EXPORT_DONE }, lock: lockPanel('2026-10', { level: 'HARD', phrase: 'chiudi ottobre' }) }) },
    { id: 'export-hard-ok', label: '5 · Lock · hard: "close October 2026" typed, Close October 2026 for good', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: false, startedAt: null, problem: null, done: EXPORT_DONE }, lock: lockPanel('2026-10', { level: 'HARD', phrase: 'close October 2026' }) }) },
    { id: 'export-soft-done', label: '5 · Lock · soft-locked, with what a final close still waits for', model: inWizard('finance', 'export', { explanations: EXPLAINED, exporting: { busy: false, startedAt: null, problem: null, done: EXPORT_DONE }, lock: lockPanel('2026-10', { done: { lock: { ...LOCK_SEPTEMBER, period: OCTOBER.period, id: 'x', export: { id: EXPORT_DONE.id, number: EXPORT_DONE.number, status: 'EXPORTED' } }, warnings: ['INVOICE_REJECTED', 'STOCK_NOT_VALUED'] } }) }) },
    { id: 'export-nothing', label: '5 · Export · August: nothing changed since EXP-2026-0001 (it is closed)', model: inWizard('finance', 'export', { month: '2026-08', period: { value: AUGUST, problem: null }, lock: lockPanel('2026-08', { current: LOCK_AUGUST, level: 'HARD' }) }) },
    { id: 'export-read-only', label: '5 · Export · Read only: Export held with the permission', model: inWizard('reader', 'export', { explanations: EXPLAINED }) },
    // ---- the lock dialog ----
    { id: 'lock-dialog', label: '⋯ Lock a period · September soft-locked: make it hard, or lift it', model: base('finance', { lockDialog: dialog('2026-09', { current: LOCK_SEPTEMBER, level: 'HARD' }) }) },
    { id: 'lock-dialog-choose', label: '⋯ Lock a period · choose the month', model: base('finance', { lockDialog: dialog(null) }) },
    { id: 'lock-dialog-hard', label: '⋯ August closed for good · Finance cannot lift it (accounting.unlock)', model: base('finance', { lockDialog: dialog('2026-08', { current: LOCK_AUGUST, level: 'HARD', liftReason: 'Correzione richiesta dallo studio' }) }) },
    { id: 'lock-dialog-owner', label: '⋯ August closed for good · the Owner lifts it with a reason', model: base('owner', { lockDialog: dialog('2026-08', { current: LOCK_AUGUST, level: 'HARD', liftReason: 'Correzione richiesta dallo studio' }) }) },
    { id: 'step-up', label: 'Lifting a final close asks a fresh code first', model: base('owner', { lockDialog: dialog('2026-08', { current: LOCK_AUGUST, level: 'HARD', liftReason: 'Correzione richiesta dallo studio', liftBusy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.lift', problem: null } }) },
    { id: 'lock-refused', label: '⋯ Lock · refused: the month is closed for good', model: base('finance', { lockDialog: dialog('2026-08', { current: LOCK_AUGUST, level: 'SOFT', problem: { key: 'refusal.HARD_LOCKED', reload: false } }) }) },
  ],
})
