import { Suspense } from 'react'
import type { Metadata } from 'next'
import { AutomationPage } from '../../../../../../areas/admin/automation/AutomationPage'

export const metadata: Metadata = { title: 'Approvals, automation & AI · Nexus Factory' }

/**
 * Admin › Platform › Approvals, automation & AI (SCR-167 W2a part, B-W2a-78; areas/admin/nav.ts, alerts.rules.manage): one
 * page for every rule engine — `?view=timers` Reminders & timers (W2a); Approval rules (W2b), Automation, Run log and AI
 * (W3) are drawn held. `?rule=<id>|new` the rule dialog.
 */
export default function Page() {
  return (
    <Suspense>
      <AutomationPage />
    </Suspense>
  )
}
