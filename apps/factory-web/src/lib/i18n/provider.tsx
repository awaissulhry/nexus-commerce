'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { DEFAULT_LOCALE, type Locale } from './locales'
import { createScopedTranslator, createTranslator, type LocaleMessages, type Translate } from './messages'

/**
 * The page's language and the catalogues it needs, for client components. A server layout loads the catalogues
 * (`messagesFor`) and passes them; a nested provider adds its own namespaces, or switches the language (the office
 * layout puts the signed-in person's language over the cookie's).
 */

interface I18nState {
  locale: Locale
  messages: LocaleMessages
}

const I18nContext = createContext<I18nState>({ locale: DEFAULT_LOCALE, messages: {} })

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: LocaleMessages; children?: ReactNode }) {
  const parent = useContext(I18nContext)
  const value = useMemo<I18nState>(
    () => ({ locale, messages: parent.locale === locale ? { ...parent.messages, ...messages } : messages }),
    [locale, messages, parent],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale
}

/** A translator for one namespace (`useT('shell')('nav.admin.users')`). */
export function useT(namespace: string): Translate {
  const { locale, messages } = useContext(I18nContext)
  return useMemo(() => createTranslator(locale, messages[namespace] ?? {}), [locale, messages, namespace])
}

const LocaleSwitchContext = createContext<((locale: Locale) => void) | null>(null)

/**
 * Who changes the page's language (a link page's language buttons): the live app writes the language cookie and
 * reloads the server's text; the design index switches its own frame.
 */
export function LocaleSwitchProvider({ onChange, children }: { onChange: (locale: Locale) => void; children?: ReactNode }) {
  return <LocaleSwitchContext.Provider value={onChange}>{children}</LocaleSwitchContext.Provider>
}

/** Changes the page's language; null where nothing above offers it. */
export function useLocaleSwitch(): ((locale: Locale) => void) | null {
  return useContext(LocaleSwitchContext)
}

/** A translator over `namespace:key` keys (navigation labels name their namespace). */
export function useScopedT(fallbackNamespace: string): Translate {
  const { locale, messages } = useContext(I18nContext)
  return useMemo(() => createScopedTranslator(locale, messages, fallbackNamespace), [locale, messages, fallbackNamespace])
}
