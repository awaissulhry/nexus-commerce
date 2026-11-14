import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LabelPdfWindow } from '../../../../../../../areas/sales/returns/record/return-label/window/LabelPdfWindow'

export const metadata: Metadata = { title: 'Return label PDF · Nexus Factory' }

/** The Return label PDF window (SCR-112-label-pdf, a window page: WINDOW_PAGES; B-W2b-398): `?return=<id>&label=<id>`. */
export default function ReturnLabelPdfRoute() {
  return (
    <Suspense>
      <LabelPdfWindow />
    </Suspense>
  )
}
