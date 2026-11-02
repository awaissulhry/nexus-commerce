import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DispatchPrint } from '../../../../../../../areas/production/dispatch/print/DispatchPrint'

export const metadata: Metadata = { title: 'Dispatch list · Nexus Factory' }

/** Production › Dispatch › Print (a new tab from the board: the list per line or station; the print stylesheet hides the frame). */
export default function ProductionDispatchPrintPage() {
  return (
    <Suspense>
      <DispatchPrint />
    </Suspense>
  )
}
