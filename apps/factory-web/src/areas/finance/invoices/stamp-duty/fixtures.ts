import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../../_demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import { DEMO, NOW_DAY, permissionsOf } from '../test-mode/demo/fixtures'
import type { Quarter, Quarters } from './api'
import { taxAbilitiesOf, type StampLine } from './model'
import { StampDutyCheckView, type StampDutyCheckModel } from './view/StampDutyCheckView'
import { StampDutyDialog, type StampDutyModel } from './view/StampDutyDialog'

/**
 * SCR-441 — Stamp duty (design finance.invoices page.h ⋯ "Stamp duty this quarter" and rec:Invoice lines/precheck "stamp duty
 * decided"; B-W2b-417 on B-W2b-392's API; FIN-101), made-up data only: the year's four quarters — two paid, one late, the
 * one running —, a count that no longer matches (Recount), recording a payment (a day held with why), the switch off
 * (what waits for the accountant), a refusal; and in a draft's Before you issue the decision in words: due and charged,
 * not due, waiting for the accountant, a stamp line that no longer matches (Decide again, held for Sales). Roles: Finance,
 * Sales (no totals: the price grain; every verb held with why). Every amount is invented.
 */

const quarter = (start: string, end: string, over: Partial<Quarter>): Quarter => ({ id: `0190f0e2-7373-7000-8000-${start.replace(/-/g, '')}0000`, version: 2, companyId: DEMO.id, quarterStart: start, quarterEnd: end, invoiceCount: 0, total: 0, liveCount: 0, liveTotal: 0, stale: false, dueOn: '2026-05-31', f24Code: '2521', deferred: false, state: 'PAID', paidAt: null, ...over })

const QUARTERS: Quarters = {
  companyId: DEMO.id,
  year: 2026,
  today: NOW_DAY,
  stampDutyOn: true,
  quarters: [
    quarter('2026-01-01', '2026-03-31', { invoiceCount: 12, total: 2400, liveCount: 12, liveTotal: 2400, dueOn: '2026-09-30', deferred: true, paidAt: '2026-09-28T08:00:00.000Z' }),
    quarter('2026-04-01', '2026-06-30', { invoiceCount: 9, total: 1800, liveCount: 9, liveTotal: 1800, dueOn: '2026-09-30', f24Code: '2522', paidAt: '2026-09-28T08:00:00.000Z' }),
    quarter('2026-07-01', '2026-09-30', { invoiceCount: 14, total: 2800, liveCount: 15, liveTotal: 3000, stale: true, dueOn: '2026-11-30', f24Code: '2523', state: 'TO_PAY' }),
    quarter('2026-10-01', '2026-12-31', { invoiceCount: 6, total: 1200, liveCount: 6, liveTotal: 1200, dueOn: '2027-02-28', f24Code: '2524', state: 'OPEN' }),
  ],
}

type StampCase = { role: Role; kind: 'quarters'; quarters: StampDutyModel } | { role: Role; kind: 'check'; check: StampDutyCheckModel }

const quarters = (role: Role, over: Partial<StampDutyModel> = {}): StampCase => {
  const price = permissionsOf(role).includes('money.price')
  return { role, kind: 'quarters', quarters: { can: taxAbilitiesOf(permissionsOf(role)), price, today: NOW_DAY, year: 2026, years: [2025, 2026], quarters: { value: QUARTERS, problem: null }, paying: null, paidOn: NOW_DAY, busy: false, problem: null, notice: null, ...over } }
}

const line = (ok: boolean, key: string, params?: Record<string, string>, again = false): StampLine => ({ ok, words: params ? { key, params } : { key }, again })
const check = (role: Role, over: Partial<StampDutyCheckModel>): StampCase => ({ role, kind: 'check', check: { line: null, readProblem: null, held: null, problem: null, busy: false, ...over } })

function StampDesign({ model }: { model: StampCase }) {
  if (model.kind === 'quarters') return inShell('/finance/invoices', createElement(StampDutyDialog, { model: model.quarters }), model.role)
  const record = recordScreen.cases.find((item) => item.id === 'draft-checks-fail')!.model.record
  return inShell('/finance/invoices/draft', createElement(InvoiceRecordView, { model: record, depth: { precheck: createElement(StampDutyCheckView, { model: model.check }) } }), model.role)
}

export const designScreen = defineDesignScreen<StampCase>({
  screen: 'SCR-441',
  title: 'Stamp duty: this quarter and the year (recount, record the payment) and "stamp duty decided" before an invoice is issued',
  view: StampDesign,
  cases: [
    { id: 'quarters', label: 'Finance · Q4 running; Q3 to pay and counted before an invoice arrived (Recount); Q1, Q2 paid', model: quarters('finance') },
    { id: 'pay', label: 'Finance · Record the payment of Q3 (the F24 code, a day after the quarter ended)', model: quarters('finance', { paying: QUARTERS.quarters[2]!, paidOn: '2026-11-12' }) },
    { id: 'pay-held', label: 'Finance · A payment day inside the quarter: held with why', model: quarters('finance', { paying: QUARTERS.quarters[2]!, paidOn: '2026-09-15' }) },
    { id: 'recounted', label: 'Finance · Q3 counted again (notice)', model: quarters('finance', { notice: { key: 'stamp.recounted', params: { n: 3, year: '2026', count: 15 } }, quarters: { value: { ...QUARTERS, quarters: QUARTERS.quarters.map((entry, index) => (index === 2 ? { ...entry, invoiceCount: 15, total: 3000, stale: false } : entry)) }, problem: null } }) },
    { id: 'switch-off', label: 'Finance · The switch is off: what waits for the accountant; Recount held', model: quarters('finance', { quarters: { value: { ...QUARTERS, stampDutyOn: false }, problem: null } }) },
    { id: 'refused', label: 'Finance · Refused: the quarter is still running (said in words)', model: quarters('finance', { problem: { key: 'finance-invoices-depth:refusal.QUARTER_OPEN', reload: false } }) },
    { id: 'sales', label: 'Sales · Counts only (no totals without the price grain); every verb held with why', model: quarters('sales') },
    { id: 'loading', label: 'Loading', model: quarters('finance', { quarters: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: quarters('finance', { quarters: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'check-due', label: 'Finance · Before you issue: stamp duty decided, 2.00 EUR charged as a line', model: check('finance', { line: line(true, 'stamp.check.DUE', { amount: '2,00 €' }) }) },
    { id: 'check-not-due', label: 'Finance · Before you issue: stamp duty not due', model: check('finance', { line: line(true, 'stamp.check.NOT_DUE') }) },
    { id: 'check-switch-off', label: 'Finance · Before you issue: stamp duty waits for the accountant', model: check('finance', { line: line(true, 'stamp.check.SWITCH_OFF') }) },
    { id: 'check-mismatch', label: 'Finance · The stamp line no longer matches the lines: Decide again', model: check('finance', { line: line(false, 'stamp.check.mismatch', undefined, true) }) },
    { id: 'check-mismatch-sales', label: 'Sales · Decide again held with why', model: check('sales', { line: line(false, 'stamp.check.mismatch', undefined, true), held: { key: 'held.noManage' } }) },
    { id: 'check-loading', label: 'Before you issue: the decision is read', model: check('finance', {}) },
    { id: 'check-error', label: 'Before you issue: the decision could not be read (Try again)', model: check('finance', { readProblem: 'problem.read.unavailable' }) },
  ],
})
