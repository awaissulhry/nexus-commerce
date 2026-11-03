import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SdsTab } from '../../../../../../../areas/plant/chemicals/sds/SdsTab'

export const metadata: Metadata = { title: 'Safety data sheet · Nexus Factory' }

/** Plant › Health & safety › Chemicals & waste › SDS (PDF) (a new tab): `?chemical=&sheet=`. */
export default function SdsRoute() {
  return (
    <Suspense>
      <SdsTab />
    </Suspense>
  )
}
