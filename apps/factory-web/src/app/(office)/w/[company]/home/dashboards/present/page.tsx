import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DashboardsPage } from '../../../../../../../areas/home/dashboards/DashboardsPage'

export const metadata: Metadata = { title: 'Dashboard · Present · Nexus Factory' }

/**
 * Home › Insights › Dashboards › Present (SCR-490; design home.dashboards tab:present): the same dashboard in its own window for a
 * TV or a projector in the weekly meeting — the panels large, reading themselves again every five minutes, no controls. A window
 * page (shell/nav/office-nav.ts WINDOW_PAGES): the shell draws only its slim bar.
 */
export default function HomeDashboardsPresentPage() {
  return (
    <Suspense>
      <DashboardsPage mode="present" />
    </Suspense>
  )
}
