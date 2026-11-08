'use client'

import { useMemo } from 'react'
import { DEFAULT_TIME_ZONE, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { dayWriter } from '../orders/words'
import { NS, shown, type Translate, type Words } from './model'

/** The words of Ship notices (`portal-deliveries`) and the page's day, time and quantity writers (Europe/Rome). */
export interface DeliveryWords {
  readonly t: Translate
  readonly locale: Locale
  /** A calendar day (`YYYY-MM-DD`) in the page's language. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  /** "1.200,5 ft²". */
  readonly qty: (value: string, uom: string | null) => string
  /** A sentence of the model. */
  readonly say: (words: Words) => string
}

export function deliveryWordsOf(t: Translate, locale: Locale): DeliveryWords {
  return {
    t,
    locale,
    day: dayWriter(locale),
    at: (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    qty: (value: string, uom: string | null) => (uom ? `${shown(value, locale)} ${t(`uom.${uom}`)}` : shown(value, locale)),
    say: (words: Words) => t(words.key, words.params),
  }
}

export function useDeliveryWords(): DeliveryWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => deliveryWordsOf(t, locale), [t, locale])
}
