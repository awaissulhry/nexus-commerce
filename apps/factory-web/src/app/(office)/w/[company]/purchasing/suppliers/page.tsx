import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PartiesList } from '../../../../../../areas/parties/_shared/PartiesList'

export const metadata: Metadata = { title: 'Suppliers · Nexus Factory' }

/**
 * Purchasing › Suppliers (SCR-056; areas/purchasing/nav.ts, parties.view): the same party record as Customers, seen
 * from the buying side. `?view=` names a saved filter, `?new=1` opens New supplier.
 */
export default function SuppliersPage() {
  return (
    <Suspense>
      <PartiesList side="suppliers" />
    </Suspense>
  )
}
