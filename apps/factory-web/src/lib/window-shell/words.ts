import { useMemo } from 'react'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'

/**
 * owb-b5 (w5.3) — the window frame's own words (Cancel, Close, Working on it…), read straight from the catalogue as the shared order
 * cells read theirs (lib/order-cells/words.ts): no page has to load a namespace for them, and office, portal and floor windows say
 * them the same way (outside: `outside-words.json` wins key by key). Everything else a window says is its host's.
 */
export const WINDOW_SHELL_NS = 'window-shell'

const CACHE = new Map<string, Translate>()

/** The frame's words in a language, as `reader` reads them (built once per language and reader). */
export function windowWordsFor(locale: Locale, reader: Reader): Translate {
  const key = `${locale}:${reader}`
  let words = CACHE.get(key)
  if (!words) {
    words = createTranslator(locale, catalogueFor(locale, WINDOW_SHELL_NS, reader))
    CACHE.set(key, words)
  }
  return words
}

/** The frame's words in the page's language and its reader's words. */
export function useWindowWords(): Translate {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => windowWordsFor(locale, reader), [locale, reader])
}
