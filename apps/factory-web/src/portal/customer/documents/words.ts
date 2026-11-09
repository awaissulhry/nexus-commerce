'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatNumber, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from './model'

/** The words of the customer's Documents (`portal-documents`) and the page's day, time and money writers (Europe/Rome). */
export interface DocumentWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) or an instant, as a day in the page's language. */
  readonly day: (iso: string) => string
  /** An instant's time ("10:42"). */
  readonly time: (iso: string) => string
  /** An instant: day and time in the site's zone. */
  readonly at: (iso: string) => string
  /** Minor units (cents) of a currency. */
  readonly money: (minor: number, currency: string) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before; an instant in the site's zone. */
export const dayWriter = (locale: Locale) => (iso: string) => (iso.length <= 10 ? formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' }) : formatDate(iso, { locale }))
export const moneyWriter = (locale: Locale) => (minor: number, currency: string) => formatNumber(minor / 100, locale, { style: 'currency', currency })

export function documentWordsOf(t: DocumentWords['t'], locale: Locale): DocumentWords {
  return {
    t,
    locale,
    day: dayWriter(locale),
    time: (iso: string) => formatTime(iso, { locale }),
    at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    money: moneyWriter(locale),
  }
}

export function useDocumentWords(): DocumentWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => documentWordsOf(t, locale), [t, locale])
}
