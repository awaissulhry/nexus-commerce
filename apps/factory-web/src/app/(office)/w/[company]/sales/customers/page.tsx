import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PartiesList } from '../../../../../../areas/parties/_shared/PartiesList'

export const metadata: Metadata = { title: 'Customers · Nexus Factory' }

/**
 * Sales › Customers (SCR-032; areas/sales/nav.ts, parties.view). The company layout above loaded the session and draws
 * the Office shell; the page is the client container, which reads the list through the API. `?view=` names a saved
 * filter (`vies`, `invoice`, `blocked` …), `?new=1` opens New customer.
 */
export default function CustomersPage() {
  return (
    <Suspense>
      <PartiesList side="customers" />
    </Suspense>
  )
}
