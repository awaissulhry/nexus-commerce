import type { ReactNode } from 'react'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { requestLocale } from '../../lib/i18n/server'

/**
 * The sign-in pages (SCR-001): no office chrome and no session. Their text (`auth`) in the request's language: the
 * language cookie, else the browser's, else Italian (the person is not known yet).
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale()
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['auth'])}>
      {children}
    </I18nProvider>
  )
}
