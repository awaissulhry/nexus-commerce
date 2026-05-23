// PO.2 — Purchase-order detail page.
//
// Shareable deep-link (/fulfillment/purchase-orders/PO-2026-0042-id).
// Full-screen layout replaces the inline card expander from the list.
// Print-friendly via @media print rules inside the client component.

import PurchaseOrderDetailClient from './PurchaseOrderDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <PurchaseOrderDetailClient id={id} />
}
