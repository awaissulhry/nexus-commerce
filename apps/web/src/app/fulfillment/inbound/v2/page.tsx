// F.5 (TECH_DEBT #50) — v2024-03-20 FBA inbound flow surface.
//
// Wraps the FbaInboundV2Wizard client component. Replaces the
// single-form FbaTransportBooking inside InboundWorkspace as the
// recommended path for new inbound shipments. The legacy v0 form
// stays in place with its "Use Seller Central — v0 deprecated"
// banner until the operator migrates fully.

import FbaInboundV2Wizard from './FbaInboundV2Wizard'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function FbaInboundV2Page() {
  return (
    <FbaInboundV2Wizard
      breadcrumbs={[
        { label: 'Fulfillment', href: '/fulfillment' },
        { label: 'Inbound', href: '/fulfillment/inbound' },
        { label: 'FBA v2024-03-20' },
      ]}
    />
  )
}
