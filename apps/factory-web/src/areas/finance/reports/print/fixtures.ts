import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_USER } from '../../../../shell/design-data'
import { canAs, inShell, TODAY, VALUATION, VALUATION_SEPTEMBER, withoutCost, type Role } from '../demo/fixtures'
import { addressOf } from '../model'
import { ValuationPrintView, type ValuationPrintModel } from './view/ValuationPrintView'

/**
 * SCR-239-print — the stock valuation on paper (design finance.reports tab:print, "a dated document for the accountant"),
 * made-up data only: today and as at 30 September (Finance), quantities only (Warehouse), reading, failed.
 */

interface Case {
  role: Role
  page: ValuationPrintModel
}

const base = (role: Role, over: Partial<ValuationPrintModel> = {}): Case => {
  const can = canAs(role)
  return {
    role,
    page: { person: DEMO_USER.displayName, company: DEMO_COMPANIES[0].name, can, address: addressOf(null), today: TODAY, valuation: { value: can.cost ? VALUATION : withoutCost(VALUATION), problem: null }, readAt: '2026-10-30T08:39:00.000Z', ...over },
  }
}

function PrintDesign({ model }: { model: Case }) {
  return inShell('/finance/reports/print', createElement(ValuationPrintView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-239-print',
  title: 'Stock valuation (print): a dated document for the accountant',
  view: PrintDesign,
  cases: [
    { id: 'finance', label: 'Finance · today, by category with values', model: base('finance') },
    { id: 'as-at', label: 'As at 30 September 2026', model: base('finance', { address: { ...addressOf(null), asOf: '2026-09-30' }, valuation: { value: VALUATION_SEPTEMBER, problem: null } }) },
    { id: 'warehouse', label: 'Warehouse · quantities only (no cost grain)', model: base('warehouse') },
    { id: 'loading', label: 'Reading', model: base('finance', { valuation: { value: null, problem: null }, readAt: null }) },
    { id: 'error', label: "Couldn't load", model: base('finance', { valuation: { value: null, problem: 'problem.unavailable' }, readAt: null }) },
  ],
})
