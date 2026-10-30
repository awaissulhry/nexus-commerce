import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RequestsPrint } from '../../../../../../../areas/plant/requests/print/RequestsPrint'

export const metadata: Metadata = { title: 'Open machine requests · Nexus Factory' }

/** Plant › Machine requests › Print (a new tab from the queue's ⋯: the open requests on paper for the shift). */
export default function PlantRequestsPrintPage() {
  return (
    <Suspense>
      <RequestsPrint />
    </Suspense>
  )
}
