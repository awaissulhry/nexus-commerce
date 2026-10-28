import type { Metadata } from 'next'
import { OfficeAuth } from '../_auth/OfficeAuth'

export const metadata: Metadata = { title: 'Nexus Factory', referrer: 'no-referrer' }

/** `/accept-invitation#token=…` — the address in the invitation mail (the API's `auth.link('/accept-invitation', …)`). */
export default function AcceptInvitationPage() {
  return <OfficeAuth start="invite" />
}
