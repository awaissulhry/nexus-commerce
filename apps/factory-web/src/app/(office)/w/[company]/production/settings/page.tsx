import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FloorRulesPage } from '../../../../../../areas/production/settings/FloorRulesPage'

export const metadata: Metadata = { title: 'Floor rules & codes · Nexus Factory' }

/**
 * Production › Settings › Floor rules & codes (SCR-074; areas/production/nav.ts, permission production.settings.view):
 * per site, who floor records name (the monitoring switch with its legal basis), the floor checks and bundle codes, the
 * standard bundle size, the floor's reason codes, off-standard codes and help-call routing. `?site=`,
 * `?tab=rules|codes|offstd|calls`.
 */
export default function ProductionSettingsPage() {
  return (
    <Suspense>
      <FloorRulesPage />
    </Suspense>
  )
}
