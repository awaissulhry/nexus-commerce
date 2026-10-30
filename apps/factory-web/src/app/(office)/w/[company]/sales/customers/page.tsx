import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CustomersPage as CustomersList } from '../../../../../../areas/sales/customers/CustomersPage'

export const metadata: Metadata = { title: 'Customers · Nexus Factory' }

/**
 * Sales › Customers (SCR-032; areas/sales/nav.ts, parties.view). The company layout above loaded the session and draws
 * the Office shell; the page is the client container, which reads the list through the API. `?view=` names a saved
 * filter (`vies`, `invoice`, `blocked` …), `?new=1` opens New customer; the band's Import opens the customers import.
 */
export default function CustomersPage() {
  return (
    <Suspense>
      <CustomersList />
    </Suspense>
  )
}
