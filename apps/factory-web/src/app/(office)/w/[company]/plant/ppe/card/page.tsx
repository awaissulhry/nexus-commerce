import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CardTab } from '../../../../../../../areas/plant/ppe/card/CardTab'

export const metadata: Metadata = { title: 'PPE card · Nexus Factory' }

/** Plant › Health & safety › PPE for workers › Person PPE card (print) (a new tab): `?person=<employee id>[&person=…]`. */
export default function PpeCardRoute() {
  return (
    <Suspense>
      <CardTab />
    </Suspense>
  )
}
