'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from './model'

/** The words of the brand's Samples & tech packs (`portal-samples`) and the page's day and time writers (Europe/Rome). */
export interface SamplesWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) or an instant, as a day in the page's language. */
  readonly day: (iso: string) => string
  /** An instant's time ("10:42"). */
  readonly time: (iso: string) => string
  /** An instant: day and time in the site's zone. */
  readonly at: (iso: string) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before; an instant in the site's zone. */
export const dayWriter = (locale: Locale) => (iso: string) => (iso.length <= 10 ? formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' }) : formatDate(iso, { locale }))

export function samplesWordsOf(t: SamplesWords['t'], locale: Locale): SamplesWords {
  return { t, locale, day: dayWriter(locale), time: (iso: string) => formatTime(iso, { locale }), at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }) }
}

export function useSamplesWords(): SamplesWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => samplesWordsOf(t, locale), [t, locale])
}
