'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from './model'

/** The words of the customer's request page (`portal-requests`, B-TH-222) and its writers of days and times (Europe/Rome). */
export interface RequestWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`), written at noon UTC so no zone moves it. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
}

export function requestWordsFor(t: RequestWords['t'], locale: Locale): RequestWords {
  return {
    t,
    locale,
    day: (iso) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' }),
    at: (iso) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
  }
}

export function useRequestWords(): RequestWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => requestWordsFor(t, locale), [t, locale])
}
