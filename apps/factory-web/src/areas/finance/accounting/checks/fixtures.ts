import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../demo/fixtures'
import type { AccountingPackage, PeriodAnswer } from '../api'
import type { WizardStep } from '../model'
import type { AccountingModel, WizardModel } from '../view-model'
import { AccountingView } from '../view/AccountingView'
import { EXPLAINED_ALL, EXPORT_DONE_BRIDGE, INTEGRITY_CASES, OCTOBER_BRIDGE, OCTOBER_JOURNALS, withoutCostSums, wizardPageOf } from './demo/fixtures'

/**
 * SCR-482 — the accountant's bridge in the export wizard (B-W2b-426; design finance.accounting sec:step-checks "work orders
 * closed (W2b)", sec:step-contents "cost of goods sold and variances (W2b) · VAT registers (W2b)"; B-W2b-408's API) with
 * made-up data only: 2 · Checks with the cost of goods sold chosen ("Work orders closed" failing with its work orders), with
 * the journals on ("Every account mapped" naming its keys, opened on the account mapping; "Journal entries balance") and the
 * nightly checks (all passed, two failing with their records, never run, running, read only, loading, error); 3 · Contents
 * with the cost of goods sold and the VAT registers offered and their sums by grain, the journals' line (off, on), a role
 * without the cost grain; 4 · Review with their totals; 5 · Export with their files and the entries files once made.
 */

interface Case {
  role: Role
  page: AccountingModel
}

const BRIDGE: AccountingPackage[] = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT']
const at = (role: Role, step: WizardStep, over: Partial<WizardModel> = {}, answer: PeriodAnswer = OCTOBER_BRIDGE): Case => ({ role, page: wizardPageOf(role, step, over, answer) })

function BridgeDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting', createElement(AccountingView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-482',
  title: 'Accounting export · the bridge: work orders closed, the mapping’s checks, the nightly checks, cost of goods sold and VAT registers',
  view: BridgeDesign,
  cases: [
    // ---- 2 · Checks ----
    { id: 'checks', label: '2 · Checks · cost of goods sold chosen: "Work orders closed" fails with WO-2026-0041 and WO-2026-0044', model: at('finance', 'checks', { chosen: BRIDGE }), note: 'Continue is held "5 checks fail without an explanation"; each work order opens in a new tab.' },
    { id: 'checks-journals', label: '2 · Checks · the journals on: "Every account mapped" names 3 keys (opened on the account mapping), the entries balance', model: at('finance', 'checks', { chosen: BRIDGE }, OCTOBER_JOURNALS) },
    { id: 'checks-explained', label: '2 · Checks · every failing check explained (the bridge’s too)', model: at('finance', 'checks', { chosen: BRIDGE, explanations: EXPLAINED_ALL }, OCTOBER_JOURNALS) },
    { id: 'nightly-failing', label: 'Nightly checks · a payment not placed, two exported documents changed since (run by a person this morning)', model: at('finance', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.failing }) },
    { id: 'nightly-running', label: 'Nightly checks · Run the checks now: running', model: at('finance', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.running }) },
    { id: 'nightly-never', label: 'Nightly checks · a new company: not run yet', model: at('finance', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.never }) },
    { id: 'nightly-read-only', label: 'Nightly checks · Read only: Run the checks now held (accounting.export)', model: at('reader', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.reader }) },
    { id: 'nightly-loading', label: 'Nightly checks · reading', model: at('finance', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.loading }) },
    { id: 'nightly-error', label: "Nightly checks · couldn't load, Try again", model: at('finance', 'checks', { chosen: BRIDGE, integrity: INTEGRITY_CASES.error }) },
    // ---- 3 · Contents ----
    { id: 'contents', label: '3 · Contents · cost of goods sold and variances, VAT registers ticked with their sums; the journals go without entries (off)', model: at('finance', 'contents', { chosen: BRIDGE, explanations: EXPLAINED_ALL }) },
    { id: 'contents-journals', label: '3 · Contents · the journals on: they go with their entries', model: at('finance', 'contents', { chosen: BRIDGE, explanations: EXPLAINED_ALL }, OCTOBER_JOURNALS) },
    { id: 'contents-defaults', label: '3 · Contents · as first read: the journals and Intrastat ticked, the bridge’s packages offered', model: at('finance', 'contents', { explanations: EXPLAINED_ALL }) },
    { id: 'contents-no-cost', label: '3 · Contents · without the cost grain: cost of goods sold and the VAT registers held in words', model: at('financePrice', 'contents', { explanations: EXPLAINED_ALL }, withoutCostSums(OCTOBER_BRIDGE)) },
    // ---- 4 · Review and 5 · Export ----
    { id: 'review', label: '4 · Review · cost of goods sold 7,440.00, variances 186.50, PPV 44.00; VAT due 1,672.00', model: at('finance', 'review', { chosen: BRIDGE, explanations: EXPLAINED_ALL }) },
    { id: 'export', label: '5 · Export · the files it will make, the bridge’s packages among them', model: at('finance', 'export', { chosen: BRIDGE, explanations: EXPLAINED_ALL }) },
    { id: 'export-done', label: '5 · Export · EXP-2026-0004 made: each journal with its entries file, the VAT registers', model: at('finance', 'export', { chosen: BRIDGE, explanations: EXPLAINED_ALL, exporting: { busy: false, startedAt: null, problem: null, done: EXPORT_DONE_BRIDGE } }, OCTOBER_JOURNALS) },
  ],
})
