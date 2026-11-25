import { useMemo } from 'react'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'
import { ORDER_LIST_NS } from '../order-groups/groups'

/**
 * pg-w1 (18-lead-settles Z2: one source, read where they live) — the words the shared order cells say themselves, read straight from
 * the catalogue as the production parts read theirs (lib/production/words.ts: no provider needed, so the office's sheet and the
 * portal's list draw the same cell the same way), in the words its reader reads (outside: `outside-words.json` wins key by key).
 * The office's stay in their catalogues (`orders`, `orders-sheet`); the customer face's new ones in `order-list` › `customer.*`.
 */

export interface CellWords {
  readonly orders: Translate
  readonly sheet: Translate
  readonly list: Translate
}

const CACHE = new Map<string, CellWords>()

/** The cells' words in a language, as `reader` reads them (built once per language and reader). */
export function cellWordsFor(locale: Locale, reader: Reader): CellWords {
  const key = `${locale}:${reader}`
  let words = CACHE.get(key)
  if (!words) {
    words = Object.freeze({
      orders: createTranslator(locale, catalogueFor(locale, 'orders', reader)),
      sheet: createTranslator(locale, catalogueFor(locale, 'orders-sheet', reader)),
      list: createTranslator(locale, catalogueFor(locale, ORDER_LIST_NS, reader)),
    })
    CACHE.set(key, words)
  }
  return words
}

/** The cells' words in the page's language and its reader's words. */
export function useCellWords(): CellWords {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => cellWordsFor(locale, reader), [locale, reader])
}
