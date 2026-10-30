import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlanningSettingsPage } from '../../../../../../areas/planning/settings/PlanningSettingsPage'

export const metadata: Metadata = { title: 'Planning settings · Nexus Factory' }

/**
 * Planning › Settings › Planning settings (SCR-124 Calendars & shifts, SCR-127 Item planning settings;
 * areas/planning/nav.ts, permission planning.view). The company layout above loaded the session and draws the Office
 * shell; the page is the client container (`?site=` `?tab=calendars|items|reorder|horizon|efficiency` and each tab's own
 * terms).
 */
export default function PlanningSettingsRoute() {
  return (
    <Suspense>
      <PlanningSettingsPage />
    </Suspense>
  )
}
