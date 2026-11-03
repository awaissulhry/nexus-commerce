import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RulesPage } from '../../../../../../areas/quality/settings/RulesPage'

export const metadata: Metadata = { title: 'Quality rules · Nexus Factory' }

/**
 * Quality › Settings › Quality rules (SCR-260; areas/quality/nav.ts, quality.rules.view). The company layout above loaded
 * the session and draws the Office shell; the page is the client container. `?scope=all` the rules of every company (else
 * the address's company), `?rule=<id>|new` an alert rule in its dialog.
 */
export default function QualityRulesRoute() {
  return (
    <Suspense>
      <RulesPage />
    </Suspense>
  )
}
