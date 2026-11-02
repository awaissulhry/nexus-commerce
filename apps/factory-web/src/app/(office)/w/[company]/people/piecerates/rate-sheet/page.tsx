import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RateSheet } from '../../../../../../../areas/people/piecerates/sheet/RateSheet'

export const metadata: Metadata = { title: 'Rate sheet · Nexus Factory' }

/** People › Piece rates › Rate sheet (a new tab: for publication and the notice board, printed from the browser). */
export default function PeopleRateSheetPage() {
  return (
    <Suspense>
      <RateSheet />
    </Suspense>
  )
}
