'use client'

import { useMemo } from 'react'
import { CATALOGUE, createTranslator, type Translate } from '../../../../lib/i18n/messages'
import { useLocale } from '../../../../lib/i18n/provider'

/** The catalogue of B-W2b-380's parts (the cost mark, the minimums edited in place, the price list PDF kept for mail). */
export const FOLLOWUPS_NAMESPACE = 'prices-followups'

/**
 * Its words in the page's language, whatever catalogues the host page provides: these parts sit inside other areas' screens
 * (a quote, an order, a price list), so they read their own catalogue rather than the host's provider.
 */
export function useFollowupsT(): Translate {
  const locale = useLocale()
  return useMemo(() => createTranslator(locale, CATALOGUE[locale][FOLLOWUPS_NAMESPACE] ?? {}), [locale])
}
