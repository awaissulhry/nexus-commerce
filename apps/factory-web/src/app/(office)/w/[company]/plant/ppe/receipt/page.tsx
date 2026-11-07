import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReceiptTab } from '../../../../../../../areas/plant/ppe/receipt/ReceiptTab'

export const metadata: Metadata = { title: 'PPE receipt · Nexus Factory' }

/** Plant › Health & safety › PPE for workers › Receipt (PDF) (a new tab): `?receipt=<id>[&receipt=…]&at=&language=`. */
export default function PpeReceiptRoute() {
  return (
    <Suspense>
      <ReceiptTab />
    </Suspense>
  )
}
