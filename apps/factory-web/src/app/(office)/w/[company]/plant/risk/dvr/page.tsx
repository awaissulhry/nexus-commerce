import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DvrTab } from '../../../../../../../areas/plant/risk/dvr/DvrTab'

export const metadata: Metadata = { title: 'DVR · Nexus Factory' }

/** Plant › Risk assessment › DVR (frozen PDF) (a new tab): `?assessment=&version=&show=seal`. */
export default function DvrRoute() {
  return (
    <Suspense>
      <DvrTab />
    </Suspense>
  )
}
