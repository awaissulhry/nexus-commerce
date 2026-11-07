import type { Metadata } from 'next'
import { Suspense } from 'react'
import { VisitListPrint } from '../../../../../../../areas/plant/health/print/VisitListPrint'

export const metadata: Metadata = { title: 'Visit list for the doctor · Nexus Factory' }

/** Plant › Health & safety › Health surveillance › the visit list for the doctor (a new tab; its reading is recorded). */
export default function VisitListPrintRoute() {
  return (
    <Suspense>
      <VisitListPrint />
    </Suspense>
  )
}
