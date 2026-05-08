import InspectClient from './InspectClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * R3.1 — Mobile inspection workspace. Tablet-on-warehouse-cart and
 * phone-in-pocket alike: single-column stack, ≥44px touch targets,
 * USB-scanner-friendly Enter handling, camera fallback for phone.
 *
 * Reached three ways:
 *   1. Direct nav from the desktop drawer's "Open inspection" button.
 *   2. Cmd+K → "Inspect by RMA" (R1.3 page commands).
 *   3. Scan-to-jump on the returns workspace.
 *
 * The desktop drawer keeps its in-place inspect controls (R0/R2.2);
 * this page is the optimized warehouse surface, not a replacement.
 */
export default async function InspectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <InspectClient returnId={id} />
}
