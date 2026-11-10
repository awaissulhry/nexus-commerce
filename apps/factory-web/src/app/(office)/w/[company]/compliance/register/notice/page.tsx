import { Suspense } from 'react'
import type { Metadata } from 'next'
import { NoticePdfWindow } from '../../../../../../../areas/compliance/register/depth/notice-pdf/NoticePdfWindow'

export const metadata: Metadata = { title: 'Authority notice PDF · Nexus Factory' }

/**
 * Compliance › PPE register › an authority notice as its PDF (SCR-329, B-W2b-271; a window page: WINDOW_PAGES; design
 * tab:rg-notice-pdf): `?notice=<id>&language=<code>`.
 */
export default function NoticePdfRoute() {
  return (
    <Suspense>
      <NoticePdfWindow />
    </Suspense>
  )
}
