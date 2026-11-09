'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS, pieces, priceText } from './model'

/**
 * The words of New order & reorder and the Catalogue (`portal-ordering`, B-W2b-194) and the pages' writers of days, times,
 * pieces and prices (Europe/Rome). Both pages and their design cases read the same writer.
 */
export interface OrderingWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) or an instant's day, in the page's language. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
  /** A decimal price with its currency ("€ 410,00"); null without a value (no price grain). */
  readonly price: (value: string | null | undefined, currency: string) => string | null
  readonly pieces: (n: number) => string
}

export const dayWriter = (locale: Locale) => (iso: string) => (iso.length === 10 ? formatDate(`${iso}T12:00:00Z`, { locale, timeZone: 'UTC' }) : formatDate(iso, { locale, timeZone: DEFAULT_TIME_ZONE }))

export function orderingWordsFor(t: OrderingWords['t'], locale: Locale): OrderingWords {
  return {
    t,
    locale,
    day: dayWriter(locale),
    at: (iso) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    price: (value, currency) => priceText(value, currency, locale),
    pieces: (n) => pieces(n, locale),
  }
}

export function useOrderingWords(): OrderingWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => orderingWordsFor(t, locale), [t, locale])
}
