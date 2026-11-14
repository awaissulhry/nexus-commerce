import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { dashboardFor, inShell, type Role } from '../demo/fixtures'
import { DashboardsView, type DashboardsModel } from '../view/DashboardsView'

/**
 * SCR-490 — Home › Insights › Dashboards › Present (design home.dashboards tab:present: "the same panels large, auto-refreshing,
 * no controls — for a TV or projector in the weekly meeting"), a window page, with made-up data only: the Owner's group view, a
 * role's dashboard, and loading.
 */

interface Case {
  readonly role: Role
  readonly model: DashboardsModel
}

function PresentDesign({ model }: { model: Case }) {
  return inShell('/home/dashboards/present', createElement(DashboardsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-490',
  title: 'Dashboard — Present (new window)',
  view: PresentDesign,
  cases: [
    { id: 'owner', label: 'Owner group, presented', model: { role: 'owner', model: dashboardFor('owner', { mode: 'present' }) }, note: 'No picker, no Arrange, no links: the dashboard’s name, scope, period and as of; the panels large; it reads itself again every 5 minutes.' },
    { id: 'plant-manager', label: 'Plant manager, presented', model: { role: 'production_manager', model: dashboardFor('production_manager', { mode: 'present' }) } },
    {
      id: 'loading',
      label: 'Loading',
      model: { role: 'owner', model: dashboardFor('owner', { mode: 'present', numbers: { status: 'loading' }, needs: { status: 'loading' }, trends: { status: 'loading' }, wip: { status: 'loading' }, byCompany: { status: 'loading' } }) },
    },
  ],
})
