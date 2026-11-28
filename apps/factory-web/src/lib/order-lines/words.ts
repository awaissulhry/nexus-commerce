import { useMemo } from 'react'
import { formatNumber } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import { catalogueFor, createTranslator, type Reader, type Translate } from '../i18n/messages'
import { useLocale, useReader } from '../i18n/provider'

/**
 * owb-po3 — the ONE lines table's own words (`messages/<locale>/order-lines.json`), read straight from the catalogue as the window
 * frame reads its own (lib/window-shell/words.ts): a host mounts the table without loading a namespace (the portal's New order, the
 * portal Lines tab, S2's office Lines tab), and each door reads its own register (the portal: `outside-words.json` wins key by key;
 * the catalogue itself is written in the portal's "voi", the office keys say "the customer" in `office.<key>`).
 */
export const ORDER_LINES_NS = 'order-lines'

const CACHE = new Map<string, Translate>()

export function linesWordsFor(locale: Locale, reader: Reader): Translate {
  const key = `${locale}:${reader}`
  let words = CACHE.get(key)
  if (!words) {
    words = createTranslator(locale, catalogueFor(locale, ORDER_LINES_NS, reader))
    CACHE.set(key, words)
  }
  return words
}

export interface LinesWords {
  readonly t: Translate
  readonly locale: Locale
  /** A decimal price with its currency ("€ 45,00"); null without a value. */
  readonly money: (value: string | null | undefined, currency: string) => string | null
  readonly count: (n: number) => string
}

export function linesKitFor(t: Translate, locale: Locale): LinesWords {
  return {
    t,
    locale,
    money: (value, currency) => {
      if (value === null || value === undefined) return null
      const number = Number(value)
      return Number.isFinite(number) ? formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null
    },
    count: (n) => formatNumber(n, locale, { maximumFractionDigits: 0 }),
  }
}

export function useLinesWords(): LinesWords {
  const locale = useLocale()
  const reader = useReader()
  return useMemo(() => linesKitFor(linesWordsFor(locale, reader), locale), [locale, reader])
}
