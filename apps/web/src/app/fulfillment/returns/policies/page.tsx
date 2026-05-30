// RX.2 — Return Policies settings. Surfaces the return-policy CRUD that
// existed in the API (GET/POST/PATCH/DELETE /fulfillment/return-policies)
// with zero UI until now. The resolver cascade (channel → marketplace →
// productType → EU baseline) drives every return-window and refund-SLA
// check across the surface; this page is where operators tune it.

export const dynamic = 'force-dynamic'

import PoliciesClient from './PoliciesClient'

export default function ReturnPoliciesPage() {
  return <PoliciesClient />
}
