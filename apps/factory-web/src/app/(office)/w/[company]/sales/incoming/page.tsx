import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InquiriesPage } from '../../../../../../areas/sales/inquiries/InquiriesPage'

export const metadata: Metadata = { title: 'Incoming · Nexus Factory' }

/**
 * Sales › Incoming (SCR-105; B-TH-216, threads plan TH-1b: Sales › Inquiries renamed — every request of every customer on one
 * page; areas/sales/nav.ts, sales.inquiries.view). The company layout above loaded the session and draws the Office shell; the
 * page is the client container. `?tile=`, `?status=`, `?source=`, `?company=`, `?party=` / `?prospect=1`, `?q=`, the request in
 * its DetailModal `?open=<id>&tab=`, New request `?new=1`, "Make incoming request" from a mail `?mail=<inbound mail id>`. The old
 * address /sales/inquiries redirects here with its query (next.config.ts, shell/nav/renamed.ts).
 */
export default function IncomingRoute() {
  return (
    <Suspense>
      <InquiriesPage />
    </Suspense>
  )
}
