import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canAs, DETAIL_221, inShell, LEDGER, METHOD_STANDARD, METHOD_UNDECIDED, NOW, PREFIX, ROWS, SITES, STANDARDS, TILES, TODAY, withoutCost, WO_221, type Role } from './demo/fixtures'
import { addressOf, periodOf, recentMonths } from './model'
import { CostingView, type CostingModel } from './view/CostingView'

/**
 * SCR-154 — Finance › Costing › Standard vs actual (design finance.costing) with made-up data only: the method in words
 * (not decided yet: every cost provisional; or chosen and locked), Cost at a glance, the work orders with standard,
 * estimate at release, actual so far and variance, the cost DetailModal (bridge, parts, materials per lot and hide,
 * labour per operation; loading, failed), the rows views (over standard, closed this month), the frozen standards, the
 * cost ledger with a reversal, Reverse entry (reason, held, refused), and the states (loading with "Still loading…",
 * error, empty, nothing matching, offline) and roles: Finance and Owner (every figure), Production manager (costing.view,
 * no money grain: minutes and quantities, Reverse held), Sales (no cost grain: no amount), Warehouse (no costing.view).
 */

interface Case {
  role: Role
  page: CostingModel
}

const ADDRESS = addressOf(null)
const ready = <T,>(rows: readonly T[]) => ({ rows, more: false, problem: null, slow: false })

const base = (role: Role, over: Partial<CostingModel> = {}): Case => {
  const can = canAs(role)
  const strip = <T extends object>(value: T): T => (can.cost ? value : withoutCost(value))
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      address: ADDRESS,
      period: periodOf(null, TODAY),
      months: recentMonths(TODAY),
      sites: SITES,
      method: METHOD_UNDECIDED,
      workOrders: { ...ready(ROWS.map(strip)), tiles: strip(TILES) },
      standards: ready(STANDARDS.map(strip)),
      ledger: ready(LEDGER.map(strip)),
      ledgerKind: null,
      readAt: NOW - 60_000,
      live: 'live',
      updates: 0,
      detail: null,
      reverse: null,
      notice: null,
      ...over,
    },
  }
}

function CostingDesign({ model }: { model: Case }) {
  return inShell('/finance/costing', createElement(CostingView, { model: model.page }), model.role)
}

const LOADING = { rows: null, more: false, problem: null, slow: true }

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-154',
  title: 'Standard vs actual: cost at a glance, work orders against their standard, standards, the cost ledger',
  view: CostingDesign,
  cases: [
    { id: 'finance', label: 'Finance · October: method not decided yet, every cost provisional', model: base('finance'), note: 'WO-2026-0221: standard 4,600.00, actual so far 5,028.00, +428.00 (+9.3 %): over standard. The ledger of WO-0221 adds up to its actual: 2,050 + 1,968 + 90 + 460 + 460 + 6 − 6 = 5,028.00.' },
    { id: 'owner', label: 'Owner · the same page', model: base('owner') },
    { id: 'method-locked', label: 'Method chosen by the accountant and locked (standard cost)', model: base('finance', { method: METHOD_STANDARD }) },
    { id: 'detail', label: 'WO-2026-0221 — cost: the bridge from the standard to the actual, J / K', model: base('finance', { address: { ...ADDRESS, open: WO_221 }, detail: { id: WO_221, value: DETAIL_221, problem: null } }), note: 'Standard 4,600.00 → material price +196.00 (4.10 vs 3.90 per ft² × 980) → material usage +312.00 (980 ft² used vs 900 planned × 3.90) → labour −80.00 (3,680 of 4,000 minutes earned so far) → actual 5,028.00.' },
    { id: 'detail-loading', label: 'The cost DetailModal reading', model: base('finance', { address: { ...ADDRESS, open: WO_221 }, detail: { id: WO_221, value: null, problem: null } }) },
    { id: 'detail-error', label: "The cost DetailModal couldn't load: Try again", model: base('finance', { address: { ...ADDRESS, open: WO_221 }, detail: { id: WO_221, value: null, problem: 'problem.unavailable' } }) },
    { id: 'detail-manager', label: 'Production manager · the cost DetailModal: minutes and quantities, no amount', model: base('manager', { address: { ...ADDRESS, open: WO_221 }, detail: { id: WO_221, value: withoutCost(DETAIL_221), problem: null } }) },
    { id: 'over', label: 'Rows ▾ Over standard (the tile is active)', model: base('finance', { address: { ...ADDRESS, rows: 'over' }, workOrders: { ...ready(ROWS.filter((row) => row.over)), tiles: TILES } }) },
    { id: 'closed', label: 'Rows ▾ Closed this month', model: base('finance', { address: { ...ADDRESS, rows: 'closed' }, workOrders: { ...ready(ROWS.filter((row) => row.final)), tiles: TILES } }) },
    { id: 'selected', label: 'Two work orders chosen · Export 2 (CSV)', model: base('finance', { selected: [ROWS[0]!.workOrder.id, ROWS[2]!.workOrder.id] }) },
    { id: 'reverse', label: 'Reverse entry: what it does and the reason', model: base('finance', { reverse: { entry: LEDGER[3]!, busy: false, problem: null }, draft: { reason: 'Leather counted twice on the issue' } }) },
    { id: 'reverse-held', label: 'Reverse entry held until the reason is typed', model: base('finance', { reverse: { entry: LEDGER[6]!, busy: false, problem: null } }) },
    { id: 'reverse-refused', label: 'Reverse entry refused (reversed already, or today locked): said in the dialog, the reason kept', model: base('finance', { reverse: { entry: LEDGER[6]!, busy: false, problem: { key: 'problem.conflict' } }, draft: { reason: 'Leather counted twice on the issue' } }) },
    { id: 'reversed', label: 'After a reversal: the notice', model: base('finance', { notice: { tone: 'success', words: { key: 'notice.reversed', params: { number: 'WO-2026-0221' } } } }) },
    { id: 'updates', label: 'Live · 3 cost events since the read', model: base('finance', { updates: 3 }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base('finance', { keysOpen: true, focusRow: 0 }) },
    { id: 'manager', label: 'Production manager · costing.view without a money grain: no amount column or tile, Reverse held', model: base('manager') },
    { id: 'sales', label: 'Sales · no cost grain: no amount (margin % lives on Margins)', model: base('sales') },
    { id: 'empty', label: 'No work orders, standards or entries in this period', model: base('finance', { address: { ...ADDRESS, month: '2026-01' }, period: periodOf('2026-01', TODAY), workOrders: { ...ready([]), tiles: { ...TILES, overStandard: 0, varianceThisMonth: 0 } }, standards: ready([]), ledger: ready([]) }) },
    { id: 'no-match', label: 'Nothing matches the search', model: base('finance', { address: { ...ADDRESS, q: 'ZZZ' }, workOrders: { ...ready([]), tiles: TILES } }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: base('finance', { workOrders: { ...LOADING, tiles: null }, standards: LOADING, ledger: LOADING, method: null, readAt: null }) },
    { id: 'error', label: "Error · couldn't load, Try again (never drawn as empty)", model: base('finance', { workOrders: { rows: null, more: false, problem: 'problem.unavailable', slow: false, tiles: null }, standards: { rows: null, more: false, problem: 'problem.unavailable', slow: false }, ledger: { rows: null, more: false, problem: 'problem.unavailable', slow: false }, readAt: null }) },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Warehouse · no costing.view', model: base('warehouse', { workOrders: { rows: null, more: false, problem: null, slow: false, tiles: null }, readAt: null }) },
  ],
})
