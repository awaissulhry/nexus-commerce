import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ServicePage } from '../../../../../../areas/sales/service/list/ServicePage'

export const metadata: Metadata = { title: 'Warranty & service · Nexus Factory' }

/**
 * Sales › After-sales › Warranty & service (SCR-217; areas/sales/nav.ts, permission sales.service.view): the service cases with
 * their tiles and notices. The client container reads `?view=`, `?kind=`, `?cover=`, `?serial=`, `?q=` and New case `?new=1`.
 */
export default function SalesServicePage() {
  return (
    <Suspense>
      <ServicePage />
    </Suspense>
  )
}
