'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { DEFAULT_LOCALE, type Locale } from './locales'
import { createScopedTranslator, createTranslator, dictionaryFor, type LocaleMessages, type Reader, type Translate } from './messages'

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

// ---- fix-voi-2: who reads the page (messages.ts Reader) ------------------------------------------------------------

const ReaderContext = createContext<Reader>('office')

/**
 * Who reads what is below: the portal's and the links' route groups (and the design index, for their screens) say
 * `outside`, so every translator below reads the outside words over the shared catalogues (`outside-words.json`).
 * Nested catalogue providers keep it.
 */
export function ReaderProvider({ reader, children }: { reader: Reader; children?: ReactNode }) {
  return <ReaderContext.Provider value={reader}>{children}</ReaderContext.Provider>
}

/** Who reads the page: `office` unless a route group says `outside`. */
export function useReader(): Reader {
  return useContext(ReaderContext)
}

/** A translator for one namespace (`useT('shell')('nav.admin.users')`), in the words its reader reads. */
export function useT(namespace: string): Translate {
  const { locale, messages } = useContext(I18nContext)
  const reader = useReader()
  return useMemo(() => createTranslator(locale, dictionaryFor(locale, namespace, messages[namespace] ?? {}, reader)), [locale, messages, namespace, reader])
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

/** A translator over `namespace:key` keys (navigation labels name their namespace), in the words its reader reads. */
export function useScopedT(fallbackNamespace: string): Translate {
  const { locale, messages } = useContext(I18nContext)
  const reader = useReader()
  return useMemo(() => createScopedTranslator(locale, messages, fallbackNamespace, reader), [locale, messages, fallbackNamespace, reader])
}
