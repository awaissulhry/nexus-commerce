import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { EXPLAINED_ALL, accountingPageOf, lockDialogOf, lockPanelOf, wizardPageOf } from '../checks/demo/fixtures'
import { EXPORT_DONE, inShell, LOCK_AUGUST, LOCK_SEPTEMBER, OCTOBER, type Role } from '../demo/fixtures'
import type { AccountingModel, LockPanelModel } from '../view-model'
import { AccountingView } from '../view/AccountingView'

/**
 * SCR-481 — "Close August for good?" (B-W2b-426; design finance.accounting pop:hard-lock, opened from 5 · Export and lock
 * and ⋯ Lock a period; FIN-155; B-W2b-408's POST /accounting/locks HARD) with made-up data only: the pop-up over step 5 —
 * the phrase not typed, on the way, wrong, right (either language), the month's problems a refused close names, the fresh
 * code asked last, closed for good — and over the lock dialog (September soft-locked, made hard); the opener held for a
 * role without accounting.close and for a month closed already. Esc closes and returns the focus to the opener.
 */

interface Case {
  role: Role
  page: AccountingModel
}

const DONE = { busy: false, startedAt: null, problem: null, done: EXPORT_DONE }

/** Step 5 after EXP-2026-0004 was made, its lock panel on Hard (the pop-up open when `hardOpen`). */
const step5 = (role: Role, lock: Partial<LockPanelModel>, page: Partial<AccountingModel> = {}): Case => {
  const base = wizardPageOf(role, 'export', { explanations: EXPLAINED_ALL, exporting: DONE, lock: lockPanelOf('2026-10', { level: 'HARD', ...lock }) }, OCTOBER)
  return { role, page: { ...base, ...page } }
}

function HardLockDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting', createElement(AccountingView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-481',
  title: 'Close a month for good: what it means, the typed phrase, the month’s problems, a fresh code last',
  view: HardLockDesign,
  cases: [
    { id: 'open', label: 'From 5 · Export and lock · "Close October 2026 for good?": nothing typed, Close October 2026 held', model: step5('finance', { hardOpen: true }), note: 'Esc closes and returns the focus to "Close October 2026 for good…".' },
    { id: 'typing', label: 'The phrase on the way: "close Oct" · Keep typing', model: step5('finance', { hardOpen: true, phrase: 'close Oct' }) },
    { id: 'mismatch', label: 'A wrong phrase: "close September 2026" · This is not the phrase', model: step5('finance', { hardOpen: true, phrase: 'close September 2026' }) },
    { id: 'match', label: 'The phrase matches · Close October 2026 (then the code)', model: step5('finance', { hardOpen: true, phrase: 'close October 2026', note: 'Consegnato allo studio il 4 novembre.' }) },
    { id: 'match-italian', label: 'Typed in Italian: "chiudi ottobre 2026" matches (either language)', model: step5('finance', { hardOpen: true, phrase: 'Chiudi  ottobre 2026' }) },
    { id: 'problems', label: 'Refused: the month still waits for an invoice rejected by SDI and stock moves without a value (every problem in words)', model: step5('finance', { hardOpen: true, phrase: 'close October 2026', closeProblems: ['INVOICE_REJECTED', 'STOCK_NOT_VALUED'], problem: { key: 'refusal.INVOICE_REJECTED', reload: false } }) },
    { id: 'step-up', label: 'The phrase and the month pass: the fresh code is asked last', model: step5('finance', { hardOpen: true, phrase: 'close October 2026', busy: true }, { stepUp: { open: true, busy: false, sentence: 'stepUp.close', problem: null } }) },
    { id: 'step-up-wrong', label: 'A wrong code: said in words, nothing closed', model: step5('finance', { hardOpen: true, phrase: 'close October 2026', busy: true }, { stepUp: { open: true, busy: false, sentence: 'stepUp.close', problem: 'stepUp.problem.wrong' } }) },
    { id: 'done', label: 'October closed for good (the panel after the pop-up)', model: step5('finance', { done: { lock: { ...LOCK_AUGUST, period: OCTOBER.period, id: 'x', export: { id: EXPORT_DONE.id, number: EXPORT_DONE.number, status: 'EXPORTED' } }, warnings: [] } }) },
    { id: 'lock-dialog', label: '⋯ Lock a period · September soft-locked, made hard: the pop-up over the lock dialog', model: { role: 'finance', page: accountingPageOf('finance', { lockDialog: lockDialogOf('2026-09', { current: LOCK_SEPTEMBER, level: 'HARD', hardOpen: true, phrase: 'chiudi settembre' }) }) } },
    { id: 'no-close', label: 'A finance role without accounting.close: "Close … for good…" held with the permission in words', model: step5('financePrice', {}) },
    { id: 'already', label: 'August closed for good already: the opener held', model: { role: 'finance', page: accountingPageOf('finance', { lockDialog: lockDialogOf('2026-08', { current: LOCK_AUGUST, level: 'HARD' }) }) } },
  ],
})
