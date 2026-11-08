import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { requestLocale } from '../../../../lib/i18n/server'

/**
 * The portal's sign-in pages (B-W2b-164, SCR-026): no frame and no session yet. Their words (`portal-signin`, and the
 * design system's `ds-words` for the code field and the end states) in the request's language: the language cookie,
 * else the browser's, else Italian — after sign-in the person's own language wins.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale()
  const t = createTranslator(locale, messagesFor(locale, ['portal-signin'])['portal-signin'] ?? {})
  return {
    title: t('meta.title'),
    // A sign-in page names a company's portal: never in a search engine, never sent as a referrer.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  }
}

export default async function PortalSignInLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale()
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['portal-signin', 'ds-words'])}>
      {children}
    </I18nProvider>
  )
}
