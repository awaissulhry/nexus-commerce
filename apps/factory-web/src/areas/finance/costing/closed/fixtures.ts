import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { WorkOrderCostRow } from '../api'
import { inShell, ROWS, TILES, type Role } from '../demo/fixtures'
import { designScreen as costingScreen } from '../fixtures'
import { designScreen as printScreen } from '../print/fixtures'
import { CostingPrintView, type CostingPrintModel } from '../print/view/CostingPrintView'
import { CostingView, type CostingModel } from '../view/CostingView'

/**
 * SCR-463 — Standard vs actual › the Status with the W2b close (design finance.costing sec:wos "status (open · closed W2b)",
 * page.live "finance.cost.closed (W2b) → Status"; B-W2b-424) with made-up data only: the invented October work orders, one
 * of them (WO-2026-0198) closed — its Status reads Closed beside the open and the final (completed) ones; the Rows ▾ view
 * "Closed in October"; a close arriving live while the page is open (the Status changes in place, no "Show" needed); the
 * production manager (no cost grain) and the variance report for paper with the same Status.
 */

const closedRows = (rows: readonly WorkOrderCostRow[]): WorkOrderCostRow[] => rows.map((row) => (row.workOrder.number === 'WO-2026-0198' ? { ...row, workOrder: { ...row.workOrder, status: 'CLOSED' } } : row))

interface Case {
  role: Role
  page?: CostingModel
  print?: CostingPrintModel
}

function ClosedDesign({ model }: { model: Case }) {
  if (model.print) return inShell('/finance/costing/print', createElement(CostingPrintView, { model: model.print }), model.role)
  return inShell('/finance/costing', createElement(CostingView, { model: model.page! }), model.role)
}

const page = (id: string, change: (page: CostingModel) => Partial<CostingModel> = () => ({})): CostingModel => {
  const base = costingScreen.cases.find((item) => item.id === id)!.model.page
  const rows = base.workOrders.rows ? closedRows(base.workOrders.rows) : null
  const withClosed = { ...base, workOrders: { ...base.workOrders, rows } }
  return { ...withClosed, ...change(withClosed) }
}
const print = printScreen.cases.find((item) => item.id === 'finance')!.model.page

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-463',
  title: 'Standard vs actual › Status: open, final, closed (W2b), changing in place when a work order is closed',
  view: ClosedDesign,
  cases: [
    { id: 'finance', label: 'Finance · WO-2026-0198 closed: its Status reads Closed beside the open ones', model: { role: 'finance', page: page('finance') } },
    { id: 'closed-rows', label: 'Rows ▾ Closed in October: completed and closed work orders', model: { role: 'finance', page: page('closed', () => ({ workOrders: { rows: closedRows(ROWS.filter((row) => row.final)), more: false, problem: null, slow: false, tiles: TILES } })) } },
    { id: 'live-closed', label: 'Live · a work order closed elsewhere: the list read again, its Status changed in place (no Show needed)', model: { role: 'finance', page: page('finance', () => ({ readAt: Date.parse('2026-10-30T08:41:00.000Z') })) }, note: 'work_order_close.changed (and workorder.status_changed) read the list again; other cost events still count behind "N updates · Show".' },
    { id: 'manager', label: 'Production manager · no cost grain: the Status without any amount', model: { role: 'manager', page: page('manager') } },
    { id: 'print', label: 'The variance report for paper: the same Status', model: { role: 'finance', print: { ...print, read: { ...print.read, rows: print.read.rows ? closedRows(print.read.rows) : null } } } },
  ],
})
