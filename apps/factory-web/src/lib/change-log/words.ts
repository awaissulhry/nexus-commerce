import { useMemo } from 'react'
import { formatDate, formatDateTime, formatNumber } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'
import { dayValueOf } from './model'

/**
 * owb-b4 w4.4 — the change log's words (`messages/<locale>/change-log.json`: the heads, the faces' words, the actions, the subjects),
 * read straight from the catalogue as `lib/order-cells/words.ts` reads its own (no provider needed: the office, the portal and the floor
 * draw the same log the same way), as its reader reads them. Times and days in the site's zone (`lib/i18n/format`).
 */

export const CHANGE_LOG_NS = 'change-log'

export interface ChangeLogWords {
  readonly t: Translate
  /** A time of a row ("28/11/2026, 09:14"). */
  readonly when: (at: string) => string
  /** A DATE value (a calendar day or an instant) as a day. */
  readonly day: (value: string) => string
  readonly count: (n: number) => string
}

const CACHE = new Map<string, ChangeLogWords>()

export function changeLogWordsFor(locale: Locale, reader: Reader = 'office'): ChangeLogWords {
  const key = `${locale}:${reader}`
  let words = CACHE.get(key)
  if (!words) {
    words = Object.freeze({
      t: createTranslator(locale, catalogueFor(locale, CHANGE_LOG_NS, reader)),
      when: (at: string) => formatDateTime(at, { locale }),
      day: (value: string) => formatDate(dayValueOf(value), { locale }),
      count: (n: number) => formatNumber(n, locale),
    })
    CACHE.set(key, words)
  }
  return words
}

/** The change log's words in the page's language and reader. */
export function useChangeLogWords(): ChangeLogWords {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => changeLogWordsFor(locale, reader), [locale, reader])
}
