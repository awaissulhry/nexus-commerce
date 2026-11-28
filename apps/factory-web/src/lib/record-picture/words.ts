import { useMemo } from 'react'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'

/**
 * owb-b4 w4.3 — the picture parts' words (`messages/<locale>/record-picture.json`), read straight from the catalogue as
 * `lib/order-cells/words.ts` reads its own (no provider needed: the office and the portal open the same window the same way), as its
 * reader reads them: outside (the portal), `outside-words.json` › `record-picture.*` wins key by key ("voi", "You decide it").
 */

export const PICTURE_NS = 'record-picture'

const CACHE = new Map<string, Translate>()

export function pictureWordsFor(locale: Locale, reader: Reader = 'office'): Translate {
  const key = `${locale}:${reader}`
  let t = CACHE.get(key)
  if (!t) {
    t = createTranslator(locale, catalogueFor(locale, PICTURE_NS, reader))
    CACHE.set(key, t)
  }
  return t
}

/** The picture words of the page's language and reader. */
export function usePictureWords(): Translate {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => pictureWordsFor(locale, reader), [locale, reader])
}
