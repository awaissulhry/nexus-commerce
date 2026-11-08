'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { LineWords } from '../../../lib/po-answer/lines'
import { NS } from './model'

/** The words of the supplier pages (`portal-supplier-orders`) and the page's day and time writers (Europe/Rome). */
export interface OrderWords extends LineWords {
  readonly at: (iso: string) => string
  /** A calendar day (`YYYY-MM-DD`) written in the page's language. */
  readonly day: (iso: string) => string
}

/** A calendar day is written at noon UTC so no zone moves it to the day before. */
export const dayWriter = (locale: Locale) => (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })

export function useOrderWords(): OrderWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => ({ t, locale, day: dayWriter(locale), at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }) }), [t, locale])
}
