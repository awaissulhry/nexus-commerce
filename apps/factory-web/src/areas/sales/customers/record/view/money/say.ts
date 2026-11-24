'use client'

import { useCallback } from 'react'
import { useLocale, useScopedT } from '../../../../../../lib/i18n/provider'
import { CM } from '../../money/model'
import { sayOf, type CustomerSay } from '../../money/say'

/**
 * F-CM-101 (18-lead-settles Z15) — the customer Money tab's words, said in the page's language: its own (`customer-money`, no prefix)
 * and the catalogue words it reuses (`orders:…`, `sales-customers-depth:…`, named in the key). Amounts in the currency handed: one
 * say per currency (a customer's money is never added across currencies).
 */
export function useSayIn(): (currency: string) => CustomerSay {
  const t = useScopedT(CM)
  const locale = useLocale()
  return useCallback((currency: string) => sayOf(t, locale, currency), [t, locale])
}
