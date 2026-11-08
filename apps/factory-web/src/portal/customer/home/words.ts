'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from './model'

/** The words of the customer's Home (`portal-customer-home`) and the page's day, time and money writers (Europe/Rome). */
export interface HomeWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) in the page's language. */
  readonly day: (iso: string) => string
  /** An instant: day and time in the site's zone. */
  readonly at: (iso: string) => string
  /** Minor units (cents) of a currency. */
  readonly money: (minor: number, currency: string) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before. */
export const dayWriter = (locale: Locale) => (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })
export const moneyWriter = (locale: Locale) => (minor: number, currency: string) => formatNumber(minor / 100, locale, { style: 'currency', currency })

export function homeWordsOf(t: HomeWords['t'], locale: Locale): HomeWords {
  return { t, locale, day: dayWriter(locale), at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }), money: moneyWriter(locale) }
}

export function useHomeWords(): HomeWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => homeWordsOf(t, locale), [t, locale])
}
