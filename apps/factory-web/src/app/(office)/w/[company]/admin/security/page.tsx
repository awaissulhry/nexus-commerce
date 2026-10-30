import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SecurityPage } from '../../../../../../areas/admin/security/SecurityPage'

export const metadata: Metadata = { title: 'Security & health · Nexus Factory' }

/**
 * Admin › Access › Security & health (SCR-166; areas/admin/nav.ts, security.view): is everything working, the sign-in
 * rules with two-factor per role, backups and restore drills, the protection in place. Sections `#status`, `#sign-in`,
 * `#backups`, `#protection`.
 */
export default function Page() {
  return (
    <Suspense>
      <SecurityPage />
    </Suspense>
  )
}
