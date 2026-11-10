import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PdfWindow } from '../../../../../../../areas/compliance/declarations/windows/PdfWindow'

export const metadata: Metadata = { title: 'Declaration PDF · Nexus Factory' }

/** The Declaration PDF window (SCR-052-pdf, a window page: WINDOW_PAGES): `?id=<document>&show=<a language of its family>`. */
export default function DeclarationPdfRoute() {
  return (
    <Suspense>
      <PdfWindow />
    </Suspense>
  )
}
