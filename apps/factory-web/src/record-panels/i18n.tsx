'use client'

import { useMemo, type ReactNode } from 'react'
import { messagesFor } from '../lib/i18n/messages'
import { I18nProvider, useLocale } from '../lib/i18n/provider'

/**
 * Adds a screen's own catalogues (`messages/<locale>/<namespace>.json`) to the page's, in the page's language. The
 * layouts load `shell` only; a screen that is its own catalogue (the record panels' `records`, Home's `home`) brings it
 * here, so the same view works inside the Office and in the design index.
 */
export function WithMessages({ namespaces, children }: { namespaces: readonly string[]; children?: ReactNode }) {
  const locale = useLocale()
  // The list's text is the dependency: a caller may pass a new array with the same names on every render.
  const key = namespaces.join(',')
  const messages = useMemo(() => messagesFor(locale, key.split(',')), [locale, key])
  return (
    <I18nProvider locale={locale} messages={messages}>
      {children}
    </I18nProvider>
  )
}
