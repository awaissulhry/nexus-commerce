import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { messagesFor } from '../../lib/i18n/messages'
import { pickLocale } from '../../lib/i18n/locales'
import { I18nProvider } from '../../lib/i18n/provider'
import { OfficeSessionProvider } from '../../lib/session/context'
import { loadOfficeSession, SIGN_IN_PATH } from '../../lib/session/server'
import { OfficeUnavailable } from '../../shell/office/OfficeUnavailable'

/**
 * The Office view's session loader (A1 §1.1, PLT-037: every office page needs a signed-in office session). It asks the
 * API who is signed in (`GET /auth/office/me`, the request's factory cookies); no session → sign-in (B-W0-26 builds
 * it). The person's own language is the page's (PLT-127). The company comes one level down, in `w/[company]/layout.tsx`.
 */
export default async function OfficeLayout({ children }: { children: ReactNode }) {
  const load = await loadOfficeSession()
  if (load.kind === 'signed_out') redirect(SIGN_IN_PATH)
  if (load.kind !== 'signed_in') return <OfficeUnavailable code={load.kind === 'unavailable' ? load.code : load.kind} />
  const locale = pickLocale({ person: load.session.user.locale })
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['shell'])}>
      <OfficeSessionProvider session={load.session}>{children}</OfficeSessionProvider>
    </I18nProvider>
  )
}
