import FbaShipmentsClient from './FbaShipmentsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** FBA shipments (Fulfillment › Outbound, Owner 2026-10-08): every product's FBA drafts and shipments in one list. */
export default function FbaShipmentsPage() {
  return <FbaShipmentsClient />
}
