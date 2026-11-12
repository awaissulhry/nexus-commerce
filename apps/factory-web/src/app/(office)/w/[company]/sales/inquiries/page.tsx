import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InquiriesPage } from '../../../../../../areas/sales/inquiries/InquiriesPage'

export const metadata: Metadata = { title: 'Inquiries · Nexus Factory' }

/**
 * Sales › Inquiries (SCR-105; areas/sales/nav.ts, sales.inquiries.view). The company layout above loaded the session and draws
 * the Office shell; the page is the client container. `?tile=`, `?source=`, `?party=` / `?prospect=1`, `?q=`, the inquiry in
 * its DetailModal `?open=<id>&tab=`, New inquiry `?new=1`, "Make an inquiry" from a mail `?mail=<inbound mail id>`.
 */
export default function InquiriesRoute() {
  return (
    <Suspense>
      <InquiriesPage />
    </Suspense>
  )
}
