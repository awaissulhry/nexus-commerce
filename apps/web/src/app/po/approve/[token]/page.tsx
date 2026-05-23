// PO-Plus.2 — Public approver page.
//
// No auth, no app chrome. Reached from the URL in the approver email
// that po-approver-email.service sends when submit-for-review trips
// the value threshold. Token lookup happens on the backend; the page
// renders a read-only PO summary + Approve / Decline panel.

import PoApproveClient from './PoApproveClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function PoApprovePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <PoApproveClient token={token} />
}
