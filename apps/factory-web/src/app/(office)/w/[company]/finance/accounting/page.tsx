import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AccountingPage } from '../../../../../../areas/finance/accounting/AccountingPage'

export const metadata: Metadata = { title: 'Accounting export · Nexus Factory' }

/**
 * Finance › Close › Accounting export (SCR-156; areas/finance/nav.ts, permission accounting.view): the numbered batches
 * for the accountant and the export wizard (`?new=1`, `?month=`), with the period locks. The company layout above loaded
 * the session and draws the Office shell; the page is the client container.
 */
export default function AccountingExportPage() {
  return (
    <Suspense>
      <AccountingPage />
    </Suspense>
  )
}
