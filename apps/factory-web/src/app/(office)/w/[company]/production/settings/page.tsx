import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FloorRulesPage } from '../../../../../../areas/production/settings/FloorRulesPage'

export const metadata: Metadata = { title: 'Floor rules & codes · Nexus Factory' }

/**
 * Production › Settings › Floor rules & codes (SCR-074; areas/production/nav.ts, permission production.settings.view):
 * per site, who floor records name (the monitoring switch with its legal basis), the standard bundle size and the
 * floor's reason codes. `?site=`, `?tab=rules|codes`.
 */
export default function ProductionSettingsPage() {
  return (
    <Suspense>
      <FloorRulesPage />
    </Suspense>
  )
}
