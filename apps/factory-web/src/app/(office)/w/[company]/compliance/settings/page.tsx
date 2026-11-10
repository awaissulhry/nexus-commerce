import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RulesMarketsPage } from '../../../../../../areas/compliance/settings/RulesMarketsPage'

export const metadata: Metadata = { title: 'Rules & markets · Nexus Factory' }

/**
 * Compliance › Settings › Rules & markets (SCR-262; areas/compliance/nav.ts, permission compliance.certificates.view): the
 * chromium VI evidence rule, the gates, the regulations and standards with their change watch, the markets, the phrases and
 * translations, the economic operators. The client container reads `?tab=`, `?scope=`, `?add=`, `?open=`, `?change=`, `?q=`,
 * `?kind=`, `?status=`, `?role=`, `?market=`, `?watch=`.
 */
export default function RulesMarketsRoute() {
  return (
    <Suspense>
      <RulesMarketsPage />
    </Suspense>
  )
}
