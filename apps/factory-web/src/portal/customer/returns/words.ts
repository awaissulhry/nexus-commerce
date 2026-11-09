'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS, type Translate } from './model'

/** The words of Returns & claims (`portal-returns`) and the page's writers of days and times (Europe/Rome). */
export interface ReturnWords {
  readonly t: Translate
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) written in the page's language. */
  readonly day: (iso: string) => string
  /** An instant, as a day (the list's "opened"). */
  readonly date: (iso: string) => string
  /** An instant, day and time. */
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before. */
export const dayWriter = (locale: Locale) => (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })

export function returnWordsFor(t: Translate, locale: Locale): ReturnWords {
  return {
    t,
    locale,
    day: dayWriter(locale),
    date: (iso: string) => formatDate(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso: string) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
  }
}

export function useReturnWords(): ReturnWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => returnWordsFor(t, locale), [t, locale])
}
