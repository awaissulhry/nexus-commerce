'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { moneyText, NS } from './model'

/** The words of Orders & tracking (`portal-orders`) and the page's writers of days, times and money (Europe/Rome). */
export interface OrderWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) written in the page's language. */
  readonly day: (iso: string) => string
  /** An instant, day and time. */
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
  /** Minor units with their currency; "—" when the reader has no price grain. */
  readonly money: (minor: number | null | undefined, currency: string | null | undefined) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before. */
export const dayWriter = (locale: Locale) => (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })

export function orderWordsFor(t: OrderWords['t'], locale: Locale): OrderWords {
  return {
    t,
    locale,
    day: dayWriter(locale),
    at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso: string) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    money: (minor, currency) => moneyText(minor, currency, locale) ?? '—',
  }
}

export function useOrderWords(): OrderWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => orderWordsFor(t, locale), [t, locale])
}
