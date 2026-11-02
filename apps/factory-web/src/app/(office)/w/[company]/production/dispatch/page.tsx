import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DispatchPage } from '../../../../../../areas/production/dispatch/DispatchPage'

export const metadata: Metadata = { title: 'Dispatch · Nexus Factory' }

/** Production › Dispatch (SCR-138): load against minutes, lanes by line and station, assign operators, move bundles. */
export default function ProductionDispatchPage() {
  return (
    <Suspense>
      <DispatchPage />
    </Suspense>
  )
}
