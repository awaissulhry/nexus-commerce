import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { TENANT_COOKIE } from '../_auth/auth-model'
import { OfficeAuth } from '../_auth/OfficeAuth'

export const metadata: Metadata = { title: 'Nexus Factory' }

/** `/forgot-password` — a reset link by email (SCR-001, PLT-070). */
export default async function ForgotPasswordPage() {
  return <OfficeAuth start="forgot" company={(await cookies()).get(TENANT_COOKIE)?.value ?? ''} />
}
