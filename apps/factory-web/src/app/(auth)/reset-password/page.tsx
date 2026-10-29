import type { Metadata } from 'next'
import { OfficeAuth } from '../_auth/OfficeAuth'

export const metadata: Metadata = { title: 'Nexus Factory', referrer: 'no-referrer' }

/** `/reset-password#token=…` — the address in the reset mail (the API's `auth.link('/reset-password', …)`). */
export default function ResetPasswordPage() {
  return <OfficeAuth start="reset" />
}
