import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, dashboardFor, inShell, layoutOfBoard, NEEDS_NONE, numbersFor, OLD_AS_OF, trendsFor, type Role } from './demo/fixtures'
import { DashboardsView, type DashboardsModel } from './view/DashboardsView'

/**
 * SCR-103 — Home › Insights › Dashboards, the Owner's group view (design home.dashboards; ANA-002, ANA-003, ANA-004), with made-up
 * data only: every company the owner reaches with the five numbers (Orders in · Shipped on time · On time in full · WIP value ·
 * Order margin), each with its line, as of and source, its records and how it is made; Needs action; Are we shipping on time?
 * with a line per company; Is work piling up?; By company and site ("1 of 2 sites"). The period, one company and a site; Arrange
 * (saved on the server) and its refusal; the explain popover; the keys; a stale number; nothing to act on; not enough weeks; a
 * panel that failed while the others work; loading; the dashboards unread; no permission. The role dashboards are SCR-031;
 * Present is SCR-490.
 */

interface Case {
  readonly role: Role
  readonly model: DashboardsModel
}

const owner = (change: Partial<DashboardsModel> = {}): Case => ({ role: 'owner', model: dashboardFor('owner', change) })
const A = COMPANIES[0]!

function DashboardsDesign({ model }: { model: Case }) {
  return inShell('/home/dashboards', createElement(DashboardsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-103',
  title: 'Dashboards — the Owner’s group view (Home › Insights)',
  view: DashboardsDesign,
  cases: [
    {
      id: 'owner',
      label: 'Owner group — every company',
      model: owner(),
      note: 'Five numbers over this month and the 11 before (a line each), as of the last rebuild and from where (orders, shipments, order lines, the cost ledger); each opens its records, ⓘ says how it is made. Needs action: five kinds, the worst first, See all 14. On time per week with the 95 % target and a line per company. Garments waiting per stage with their age. By company and site: a site figure only where a number is kept per site ("1 of 2 sites").',
    },
    { id: 'week', label: 'Period: week', model: owner({ address: { board: 'owner-group', period: 'WEEK', company: null, site: null }, numbers: { status: 'ready', value: numbersFor('owner', 'owner-group', 'WEEK') } }) },
    {
      id: 'company',
      label: 'One company and a site',
      model: owner({
        address: { board: 'owner-group', period: 'MONTH', company: A.id, site: A.sites[0]!.id },
        numbers: { status: 'ready', value: numbersFor('owner', 'owner-group', 'MONTH', (number) => (number.kpiKey === 'production.wip_value' ? {} : { wholeCompany: true })) },
        trends: { status: 'ready', value: trendsFor(true) },
      }),
      note: 'Orders, shipments and margins are kept per company: their tiles say "For the whole company"; the WIP value is the site’s own. The on-time chart is the company’s line.',
    },
    { id: 'explain', label: 'How this number is made', model: owner({ explain: 'delivery.otif' }), note: 'The KPI library’s definition, formula, where it is counted from, its period and unit, and Open in the KPI library.' },
    { id: 'arrange', label: 'Arrange (saved on the server)', model: owner({ arranging: true, layout: { status: 'ready', value: layoutOfBoard('owner-group', (panels) => panels, true) } }), note: 'The one Customise dialog: ticked = shown, drag to order, the numbers always shown; widths per panel; Back to the dashboard’s order.' },
    { id: 'arrange-refused', label: 'Arrange — refused (another window)', model: owner({ arranging: true, arrange: { busy: false, problem: 'error.stale' }, layout: { status: 'ready', value: layoutOfBoard('owner-group', (panels) => panels, true) } }) },
    {
      id: 'arranged',
      label: 'Arranged: by company first, Needs action hidden',
      model: owner({ layout: { status: 'ready', value: layoutOfBoard('owner-group', (panels) => [panels[0]!, { ...panels[3]!, width: 'FULL' }, { ...panels[2]!, width: 'TWO_THIRDS' }, { ...panels[4]!, width: 'HALF' }, { ...panels[1]!, hidden: true }], true) } }),
    },
    { id: 'keys', label: 'Keyboard shortcuts', model: owner({ keysOpen: true }) },
    {
      id: 'stale',
      label: 'A number over 3 hours old',
      model: owner({ numbers: { status: 'ready', value: numbersFor('owner', 'owner-group', 'MONTH', (number) => (number.kpiKey === 'production.wip_value' ? { asOf: OLD_AS_OF, stale: true } : {})) } }),
      note: 'Its tile says "Data is over 3 h old" in words, not only in colour.',
    },
    {
      id: 'problems',
      label: 'Numbers without a value say why',
      model: owner({
        numbers: {
          status: 'ready',
          value: numbersFor('owner', 'owner-group', 'MONTH', (number) => (number.kpiKey === 'sales.order_margin' ? { value: null, problem: 'MIXED_CURRENCIES' } : number.kpiKey === 'delivery.otif' ? { value: null, problem: 'NOT_BUILT', asOf: null } : {})),
        },
      }),
    },
    { id: 'nothing', label: 'Nothing needs action', model: owner({ needs: { status: 'ready', value: NEEDS_NONE } }) },
    { id: 'few-weeks', label: 'Not enough weeks yet', model: owner({ trends: { status: 'ready', value: trendsFor(false, [null, null, null, null, null, null, null, null, null, null, null, '92.0']) } }) },
    { id: 'panel-error', label: 'One panel failed, the others work', model: owner({ numbers: { status: 'error', problem: 'error.offline' } }), note: 'The numbers say what went wrong with Try again; Needs action, the chart and the flow strip are drawn.' },
    { id: 'loading', label: 'Loading', model: owner({ numbers: { status: 'loading' }, needs: { status: 'loading' }, trends: { status: 'loading' }, wip: { status: 'loading' }, byCompany: { status: 'loading' }, layout: { status: 'loading' } }) },
    { id: 'error', label: 'The dashboards could not be read', model: owner({ boards: { status: 'error', problem: 'error.offline' } }) },
    { id: 'no-permission', label: 'No permission', model: { role: 'admin', model: dashboardFor('admin', {}, 'owner-group') }, note: 'Without the KPI library the page says so and asks the API nothing; the navigation row is absent.' },
  ],
})
