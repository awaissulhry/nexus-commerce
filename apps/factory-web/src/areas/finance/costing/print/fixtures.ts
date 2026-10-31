import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_USER } from '../../../../shell/design-data'
import { canAs, inShell, METHOD_UNDECIDED, ROWS, TILES, TODAY, withoutCost, type Role } from '../demo/fixtures'
import { addressOf, periodOf } from '../model'
import { CostingPrintView, type CostingPrintModel } from './view/CostingPrintView'

/**
 * SCR-154-print — the variance report on paper (design finance.costing tab:print, "print stylesheet with scope written at
 * the top"), made-up data only: October with every figure (Finance), over standard only, without the cost grain
 * (Production manager), reading, failed.
 */

interface Case {
  role: Role
  page: CostingPrintModel
}

const base = (role: Role, over: Partial<CostingPrintModel> = {}): Case => {
  const can = canAs(role)
  return {
    role,
    page: {
      person: DEMO_USER.displayName,
      company: DEMO_COMPANIES[0].name,
      can,
      address: addressOf(null),
      period: periodOf(null, TODAY),
      read: { rows: can.cost ? ROWS : ROWS.map((row) => withoutCost(row)), tiles: TILES, more: false, problem: null },
      method: METHOD_UNDECIDED,
      readAt: '2026-10-30T08:39:00.000Z',
      ...over,
    },
  }
}

function PrintDesign({ model }: { model: Case }) {
  return inShell('/finance/costing/print', createElement(CostingPrintView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-154-print',
  title: 'Variance report (print): standard vs actual with the scope written at the top',
  view: PrintDesign,
  cases: [
    { id: 'finance', label: 'Finance · October, every work order with its variance', model: base('finance'), note: 'Total variance of the rows: +428.00 − 729.60 − 48.00 = −349.60.' },
    { id: 'over', label: 'Over standard only', model: base('finance', { address: { ...addressOf(null), rows: 'over' }, read: { rows: ROWS.filter((row) => row.over), tiles: TILES, more: false, problem: null } }) },
    { id: 'manager', label: 'Production manager · no money grain: no amount columns', model: base('manager') },
    { id: 'more', label: 'More than fits: the note says how many are printed', model: base('finance', { read: { rows: ROWS, tiles: TILES, more: true, problem: null } }) },
    { id: 'loading', label: 'Reading', model: base('finance', { read: { rows: null, tiles: null, more: false, problem: null }, readAt: null }) },
    { id: 'error', label: "Couldn't load", model: base('finance', { read: { rows: null, tiles: null, more: false, problem: 'problem.unavailable' }, readAt: null }) },
  ],
})
