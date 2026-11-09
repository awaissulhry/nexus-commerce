'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS, quantityIn, uomKey, type Words } from './model'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The words of the Jobs pages (`portal-jobs`) and the page's day, time and quantity writers (Europe/Rome). */
export interface JobWords {
  readonly t: Translate
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) in the page's language. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  /** A model's words (a key and its figures; a day figure named `date` is written as a day). */
  readonly say: (words: Words | null) => string | null
  /** "12,5 m" — a kit quantity with its unit in the page's language. */
  readonly quantity: (quantity: string, uom: string | null) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before. */
export const dayWriter = (locale: Locale) => (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })

export function jobWordsOf(t: Translate, locale: Locale): JobWords {
  const day = dayWriter(locale)
  return {
    t,
    locale,
    day,
    at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    say: (words) => {
      if (!words) return null
      const params = words.params ? Object.fromEntries(Object.entries(words.params).map(([name, value]) => [name, name === 'date' && typeof value === 'string' ? day(value) : value])) : undefined
      return t(words.key, params)
    },
    quantity: (quantity, uom) => `${quantityIn(quantity, locale)} ${t(uomKey(uom))}`,
  }
}

export function useJobWords(): JobWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => jobWordsOf(t, locale), [t, locale])
}
