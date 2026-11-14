import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DashboardsPage } from '../../../../../../areas/home/dashboards/DashboardsPage'

export const metadata: Metadata = { title: 'Dashboards · Nexus Factory' }

/**
 * Home › Insights › Dashboards (SCR-031 the role dashboards, SCR-103 the Owner's group view; areas/home/nav.ts, permission
 * home.kpis.view): one dashboard per role and the Owner's view across companies and sites, every number with its source and
 * freshness, opening the records behind it. The company layout above loaded the session and draws the Office shell; the page is
 * the client container.
 */
export default function HomeDashboardsPage() {
  return (
    <Suspense>
      <DashboardsPage />
    </Suspense>
  )
}
