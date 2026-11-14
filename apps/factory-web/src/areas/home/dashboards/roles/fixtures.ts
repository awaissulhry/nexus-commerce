import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { COMPANIES, dashboardFor, inShell, layoutOfBoard, numbersFor, type Role } from '../demo/fixtures'
import { DashboardsView, type DashboardsModel } from '../view/DashboardsView'

/**
 * SCR-031 — Home › Insights › Dashboards, one ready dashboard per role (design home.dashboards `picker`; ANA-001 role dashboards,
 * ANA-003, ANA-004), with made-up data only: each role sees its own dashboard first; a number the role may not read gives its
 * place to the next allowed one and says what it stands in for (never a locked tile); a panel the role may not read is absent
 * (Sales: no work in progress). Reports pinned to a dashboard (follow-up DB1:01, saved on the server); a site chosen; a dashboard
 * with no number the role reads. The Owner's group view is SCR-103.
 */

interface Case {
  readonly role: Role
  readonly model: DashboardsModel
}

const role = (who: Role, change: Partial<DashboardsModel> = {}): Case => ({ role: who, model: dashboardFor(who, change) })
const A = COMPANIES[0]!

function RolesDesign({ model }: { model: Case }) {
  return inShell('/home/dashboards', createElement(DashboardsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-031',
  title: 'Dashboards — one per role (Home › Insights)',
  view: RolesDesign,
  cases: [
    {
      id: 'planner',
      label: 'Planner — numbers outside the role replaced',
      model: role('planner', { board: { key: 'planner', mine: true, panels: ['numbers', 'needs-action', 'trends', 'wip'] } }),
      note: 'The planner’s own dashboard first ("your role" in the picker): on time in full (first and current promise), order to ship, order to start, pieces in work.',
    },
    {
      id: 'planner-owner-view',
      label: 'Planner on the Owner group view — stand-ins',
      model: { role: 'planner', model: dashboardFor('planner', {}, 'owner-group') },
      note: 'Orders in (price), WIP value (cost) and the order margin (margin) are outside the planner’s role: pieces made, pieces in work and order lines take their places, each saying what it stands in for.',
    },
    { id: 'plant-manager', label: 'Plant manager', model: role('production_manager') },
    { id: 'sales', label: 'Sales — no work in progress panel', model: role('sales'), note: 'Sales reads no production reports: Is work piling up? is absent, never a locked box.' },
    { id: 'buyer', label: 'Buyer', model: role('buyer') },
    { id: 'quality', label: 'Quality', model: role('quality_inspector') },
    { id: 'finance', label: 'Finance', model: role('finance') },
    { id: 'line-leader', label: 'Line leader', model: role('floor_supervisor') },
    {
      id: 'site',
      label: 'Plant manager at one site',
      model: role('production_manager', {
        address: { board: 'plant-manager', period: 'MONTH', company: A.id, site: A.sites[0]!.id },
        numbers: { status: 'ready', value: numbersFor('production_manager', 'plant-manager', 'MONTH', (number) => (number.kpiKey === 'production.order_to_start_days' ? { wholeCompany: true } : {})) },
      }),
      note: 'Order to start is kept per company: its tile says so; the floor’s numbers are the site’s own.',
    },
    {
      id: 'pinned',
      label: 'Reports pinned here (saved on the server)',
      model: role('sales', {
        layout: {
          status: 'ready',
          value: layoutOfBoard('sales', (panels) => [panels[0]!, { id: 'report:sales.intake', hidden: false, width: 'HALF' }, { id: 'report:sales.late-orders', hidden: false, width: 'HALF' }, ...panels.slice(1)], true),
        },
      }),
      note: 'Order intake pinned from Sales › Reports (Save as dashboard) and Late orders from the report library: each opens its report.',
    },
    {
      id: 'no-numbers',
      label: 'A dashboard with no number the role reads',
      model: { role: 'quality_inspector', model: dashboardFor('quality_inspector', { numbers: { status: 'ready', value: { board: 'finance', asOf: '2026-11-14T09:05:00.000Z', period: 'MONTH', numbers: [], withheld: ['sales.orders_in', 'production.wip_value', 'sales.margin_actual', 'sales.margin_quoted', 'sales.order_margin'] } } }, 'finance') },
    },
  ],
})
