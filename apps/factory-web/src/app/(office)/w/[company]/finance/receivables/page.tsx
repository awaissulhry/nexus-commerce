import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReceivablesPage } from '../../../../../../areas/finance/receivables/ReceivablesPage'

export const metadata: Metadata = { title: 'Receivables & credit · Nexus Factory' }

/**
 * Finance › Receivables & credit (SCR-151; areas/finance/nav.ts, permission receivables.view): what customers owe by age
 * (`?bucket=`, `?q=`, `?asOf=`), each customer's statement (`?statement=&company=&currency=`) and the reminders a person
 * approves (`?reminders=`, `?reminder=`). The page is the client container, which reads through the API.
 */
export default function FinanceReceivablesPage() {
  return (
    <Suspense>
      <ReceivablesPage />
    </Suspense>
  )
}
