import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { HIDE_COUNTS, HIDE_HOLDS, HIDE_MATCHING, HIDE_ROWS } from '../demo/fixtures'
import { CUTTING_YIELD, dashboardModel, GRADE_MIX, LEATHER_DASHBOARD, LEATHER_VALUE, PANEL_LOADING, REMNANT_TOTALS } from '../demo/w2b/fixtures'
import { dailyFor, HOLD_REASONS } from '../../lots/demo/daily/fixtures'
import { DEFAULT_HIDE_VIEW, type HideFilters, type HidesListModel } from '../model'
import { HidesListView } from '../list/view/HidesListView'
import type { LeatherDashboardModel } from './use-dashboard'
import { ITEMS, COLOURS, LOTS } from '../../../_shared/stock/fixtures'

/**
 * SCR-134 — the leather dashboard (B-W2b-131; SCM-285; design warehouse.hides sec hd-dashboard) on the Hides page, made-up
 * data only: area on hand by article and colour (areas for the warehouse; the owner with the cost grain may switch to the
 * Area value, the warehouse sees that held in words), the grade mix per lot (stacked), the remnant pieces, the area at a
 * subcontractor, the area on hold (lot not released · quality hold), the yield of the last 30 days by style and supplier lot
 * (never by cutter; held for a role without production.cutting.view); a bar pressed (the grid shows that article's hides);
 * each panel loading, failed or empty on its own; the dashboard hidden (the ⋯ menu shows it again). Roles: Owner (cost
 * grain, cutting view), Warehouse (no cost, no cutting view), Quality, Sales (no inventory.stock.view).
 */

interface DashboardCase {
  role: RoleCase
  list: HidesListModel
}

const NO_FILTERS: HideFilters = { lotId: null, grade: null, shade: null, locationId: null, itemId: null, itemColourId: null }
const inStock = HIDE_ROWS.filter((row) => row.state !== 'CONSUMED' && row.state !== 'SCRAPPED')
const ready = <T,>(value: T) => ({ value, problem: null, asOf: NOW })

function dashCase(role: RoleCase, dashboard: Partial<LeatherDashboardModel> = {}, over: Partial<HidesListModel> = {}): DashboardCase {
  const daily = dailyFor(role)
  const cost = daily.cost
  const cuttingView = role === 'owner'
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canFor(role),
      daily,
      holds: daily.holdsView ? HIDE_HOLDS : {},
      holdReasons: HOLD_REASONS,
      reserve: null,
      writeOff: null,
      view: DEFAULT_HIDE_VIEW,
      q: '',
      filters: NO_FILTERS,
      sites: [SITE, SITE_SOUTH],
      siteId: null,
      rows: { items: inStock, more: false, problem: null },
      counts: HIDE_COUNTS,
      matching: HIDE_MATCHING,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      print: null,
      canTransfer: true,
      remnantTotals: REMNANT_TOTALS,
      dashboard: dashboardModel({ cost, area: ready(cost ? LEATHER_VALUE : dashboardModel().area.value!), yield: cuttingView ? ready(CUTTING_YIELD) : { ...PANEL_LOADING, held: 'dash.yield.held' }, ...dashboard }),
      ...over,
    },
  }
}

function DashboardDesign({ model }: { model: DashboardCase }) {
  return inShell('/warehouse/hides', createElement(HidesListView, { model: model.list }), model.role)
}

const black = `${ITEMS.leather.id}|${COLOURS.black.id}`

export const designScreen = defineDesignScreen<DashboardCase>({
  screen: 'SCR-134',
  title: 'Leather dashboard (area on hand, grade mix, remnants, subcontractors, on hold, yield)',
  view: DashboardDesign,
  cases: [
    { id: 'warehouse', label: 'Warehouse: areas only (Area value held in words), yield held (no cutting room right)', model: dashCase('warehouse') },
    { id: 'owner', label: 'Owner: the cost grain and the cutting room right: every panel, the Area value series offered', model: dashCase('owner') },
    { id: 'owner-value', label: 'Owner: the bars show the Area value (money only with money.cost)', model: dashCase('owner', { series: 'value' }) },
    {
      id: 'article-pressed',
      label: 'A bar pressed: the grid below shows that article and colour (chip removable)',
      model: dashCase('warehouse', { active: { article: black, lot: null } }, { filters: { ...NO_FILTERS, itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id }, rows: { items: inStock.filter((row) => row.item.id === ITEMS.leather.id), more: false, problem: null } }),
    },
    {
      id: 'lot-pressed',
      label: 'A lot pressed in the grade mix: the grid shows its hides',
      model: dashCase('owner', { active: { article: null, lot: LOTS.nappa.id } }, { filters: { ...NO_FILTERS, lotId: LOTS.nappa.id }, rows: { items: inStock.slice(0, 5), more: false, problem: null } }),
    },
    { id: 'quality', label: 'Quality: areas, the on-hold panel, the yield held', model: dashCase('quality') },
    { id: 'loading', label: 'Every panel reading (skeletons, each its own)', model: dashCase('warehouse', { area: PANEL_LOADING, mix: PANEL_LOADING, dashboard: PANEL_LOADING }) },
    {
      id: 'panel-error',
      label: 'One read failed: the grade mix and remnants say so with Try again; the other panels stay',
      model: dashCase('owner', { mix: { value: null, problem: 'problem.offline', asOf: null } }),
    },
    {
      id: 'empty',
      label: 'No leather on hand: each panel says it in words',
      model: dashCase('owner', {
        area: ready({ ...LEATHER_VALUE, rows: [], hides: 0, areaM2: '0.0000' }),
        mix: ready({ ...GRADE_MIX, groups: [], totals: [] }),
        dashboard: ready({ ...LEATHER_DASHBOARD, atSubcontractors: { rows: [], sums: [] }, onHold: { rows: [], sums: [] } }),
        yield: ready({ ...CUTTING_YIELD, byStyleAndLot: [] }),
      }),
    },
    { id: 'hidden', label: 'Dashboard hidden (kept per person): ⋯ shows it again', model: dashCase('warehouse', { open: false }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: dashCase('sales') },
  ],
})
