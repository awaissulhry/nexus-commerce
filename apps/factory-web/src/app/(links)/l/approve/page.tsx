import { loadOfficeSession } from '../../../../lib/session/server'
import { OfficeApproval } from '../../../../links/approve/office/OfficeApproval'

/**
 * `/l/approve#key=am1…` — an office approval opened from its e-mail (PLT-089, B-W2b-188): the quick office sign-in in the
 * link column, then the approval on the office's own page (links/approve/office/OfficeApproval.tsx). Whether an office
 * session is open is read here, on the server, so a signed-out visit asks for the sign-in without a refused call.
 */
export default async function ApproveFromMailPage() {
  const load = await loadOfficeSession()
  return <OfficeApproval signedIn={load.kind === 'signed_in'} />
}
