/** ACR Stage 5 — Campaign Builder · Sponsored Brands / Sponsored Display. */
import { Suspense } from 'react'
import { SbSdBuilder } from './SbSdBuilder'

export const dynamic = 'force-dynamic'
export default function SbSdPage() {
  // useSearchParams needs a Suspense boundary under the app router.
  return (
    <Suspense fallback={null}>
      <SbSdBuilder />
    </Suspense>
  )
}
