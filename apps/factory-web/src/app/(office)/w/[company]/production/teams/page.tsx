import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TeamsPage } from '../../../../../../areas/production/teams/TeamsPage'

export const metadata: Metadata = { title: 'Teams · Nexus Factory' }

/**
 * Production › Teams (owb-ss7 7.1; design plan § 5za; areas/production/nav.ts, permission workorders.view): one column a team and one
 * for "No team yet", "Give to a team…" and "Lend a person". The company layout above loaded the session and draws the Office shell;
 * the page is the client container, which reads GET /production/teams/board (and, with people.view, today's teams) through the API.
 * Its address joins OFFICE_PAGES at the S3 land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES, lead 88's flip).
 */
export default function ProductionTeamsPage() {
  return (
    <Suspense>
      <TeamsPage />
    </Suspense>
  )
}
