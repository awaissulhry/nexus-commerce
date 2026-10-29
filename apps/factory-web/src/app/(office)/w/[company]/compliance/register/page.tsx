import { Suspense } from 'react'
import type { Metadata } from 'next'
import { RegisterPage } from '../../../../../../areas/compliance/register/RegisterPage'

export const metadata: Metadata = { title: 'PPE register · Nexus Factory' }

/**
 * Compliance › PPE register & recalls (SCR-113; areas/compliance/nav.ts, compliance.register.view). `?view=` names a
 * saved filter (the API's own `?status=`, `?kind=`, `?risk=` are read too); `?new=1` opens New entry.
 */
export default function RegisterRoute() {
  return (
    <Suspense>
      <RegisterPage />
    </Suspense>
  )
}
