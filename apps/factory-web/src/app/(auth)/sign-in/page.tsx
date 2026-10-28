'use client'

import { EmptyState } from '@nexus/ui/components'
import { useT } from '../../../lib/i18n/provider'

/**
 * PLACEHOLDER — where the office sends a person without a session. B-W0-26 replaces this page with the office sign-in
 * (SCR-001: password, authenticator code, invitation, reset).
 */
export default function SignInPlaceholderPage() {
  const t = useT('shell')
  return (
    <main id="main-content" className="fw-office-unavailable">
      <EmptyState title={t('signInPlaceholder.title')} description={t('signInPlaceholder.body')} />
    </main>
  )
}
