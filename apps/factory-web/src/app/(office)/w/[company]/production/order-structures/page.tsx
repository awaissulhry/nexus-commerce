import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrderStructuresPage } from '../../../../../../areas/production/order-structures/OrderStructuresPage'

export const metadata: Metadata = { title: 'Order structures · Nexus Factory' }

/**
 * Production › Settings › Order structures (owb-ss8 8.3; design plan § 5zj C; areas/production/nav.ts, permission workorders.view): the
 * structures, the rules (read from the top, the first that fits wins, the last line "Everything else → the normal way") and "Try an
 * order". The company layout above loaded the session and draws the Office shell; the page is the client container, which reads
 * GET /production/order-structures and GET /production/structure-rules through the API. Its address joins OFFICE_PAGES at the S3 land
 * (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES, lead 88's flip).
 */
export default function ProductionOrderStructuresPage() {
  return (
    <Suspense>
      <OrderStructuresPage />
    </Suspense>
  )
}
