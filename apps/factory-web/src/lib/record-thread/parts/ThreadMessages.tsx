'use client'

import { useMemo, type ReactNode } from 'react'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider, useLocale } from '../../i18n/provider'

/**
 * The record thread's own catalogues (`messages/<locale>/record-thread*.json`), added to the page's in the page's language:
 * the office layouts load `shell` only, and the same parts draw in the design index (which has every catalogue).
 */
export const THREAD_NAMESPACES = ['record-thread', 'record-thread-feed', 'record-thread-card', 'record-thread-composer', 'record-thread-attach', 'record-thread-send'] as const

export function ThreadMessages({ children }: { children?: ReactNode }) {
  const locale = useLocale()
  const messages = useMemo(() => messagesFor(locale, THREAD_NAMESPACES), [locale])
  return (
    <I18nProvider locale={locale} messages={messages}>
      {children}
    </I18nProvider>
  )
}
