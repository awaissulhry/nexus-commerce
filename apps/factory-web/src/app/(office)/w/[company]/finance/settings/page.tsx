import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FinanceSettingsPage } from '../../../../../../areas/finance/settings/FinanceSettingsPage'

export const metadata: Metadata = { title: 'Finance settings · Nexus Factory' }

/** Finance › Finance settings (SCR-083; permission invoices.view): what every invoice takes, per company. */
export default function FinanceSettingsRoute() {
  return (
    <Suspense>
      <FinanceSettingsPage />
    </Suspense>
  )
}
