import PackStationClient from './PackStationClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * O.13 — Pack station page. Operator weighs + measures + scan-verifies
 * a shipment, then advances it to PACKED. Reached via the "Pack &
 * ready" CTA in the outbound order drawer (O.5) or directly from the
 * Shipments tab.
 *
 * Designed for warehouse-floor hardware: large input fields, scanner
 * autofocus, single-screen flow. The scan-verify panel ensures every
 * line item in the shipment is physically picked up + scanned before
 * the PACKED transition is allowed (client-side gate; server trusts
 * the operator).
 */
export default async function PackPage({
  params,
}: {
  params: Promise<{ shipmentId: string }>
}) {
  const { shipmentId } = await params
  return <PackStationClient shipmentId={shipmentId} />
}
