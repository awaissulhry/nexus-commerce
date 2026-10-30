import { Suspense } from 'react'
import type { Metadata } from 'next'
import { OperationsPage } from '../../../../../../areas/products/operations/OperationsPage'

export const metadata: Metadata = { title: 'Operations · Nexus Factory' }

/**
 * Products › Libraries › Operations (SCR-049; product.routing.view): the operation library with standard minutes.
 * The filters are in the address (`?view=&kind=&q=`); `?new=1` opens New operation.
 */
export default function Page() {
  return (
    <Suspense>
      <OperationsPage />
    </Suspense>
  )
}
