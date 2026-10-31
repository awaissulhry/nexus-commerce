import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SalesSettingsPage } from '../../../../../../areas/sales/settings/SalesSettingsPage'

export const metadata: Metadata = { title: 'Sales settings · Nexus Factory' }

/**
 * Sales › Settings › Sales settings (SCR-235, B-W2a-77; areas/sales/nav.ts, permission quotes.view): the quote approval
 * rules and defaults, the return policy and the return and cancel reasons, the numbering's series.
 */
export default function SalesSettingsRoute() {
  return (
    <Suspense>
      <SalesSettingsPage />
    </Suspense>
  )
}
