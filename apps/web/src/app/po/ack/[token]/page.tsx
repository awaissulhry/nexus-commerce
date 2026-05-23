// PO.9 — Public supplier ack page.
//
// No auth, no app chrome. Reached from the URL embedded in the
// PO.9 send-to-supplier email. The page renders a read-only summary
// of the PO and a confirm / decline form.
//
// Token lookup happens on the backend (GET /api/po/ack/:token) — the
// page never has access to the PO id, only the token.

import PoAckClient from './PoAckClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function PoAckPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <PoAckClient token={token} />
}
