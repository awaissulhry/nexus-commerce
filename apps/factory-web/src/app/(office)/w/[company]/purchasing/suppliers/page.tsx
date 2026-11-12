import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SuppliersPage as SuppliersList } from '../../../../../../areas/purchasing/suppliers/list/SuppliersPage'

export const metadata: Metadata = { title: 'Suppliers · Nexus Factory' }

/**
 * Purchasing › Suppliers (SCR-056; areas/purchasing/nav.ts, parties.view): the same party record as Customers, seen
 * from the buying side. `?view=` names a saved filter, `?new=1` opens New supplier; B-W2b-334: `?docs=expiring` the
 * "Documents expiring in 30 days" view, the band's Import.
 */
export default function SuppliersPage() {
  return (
    <Suspense>
      <SuppliersList />
    </Suspense>
  )
}
