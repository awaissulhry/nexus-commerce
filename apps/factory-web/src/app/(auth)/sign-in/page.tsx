import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { TENANT_COOKIE } from '../_auth/auth-model'
import { OfficeAuth } from '../_auth/OfficeAuth'

export const metadata: Metadata = { title: 'Nexus Factory' }

/** `/sign-in` — where the office sends a person without a session (SCR-001). */
export default async function SignInPage() {
  return <OfficeAuth start="sign-in" company={(await cookies()).get(TENANT_COOKIE)?.value ?? ''} />
}
