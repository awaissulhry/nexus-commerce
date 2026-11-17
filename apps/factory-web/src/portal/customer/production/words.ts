'use client'

import { useMemo } from 'react'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { orderWordsFor, type OrderWords } from '../orders/words'
import { NS } from './model'

/** F-PR-11 — the words of My production (`portal-production`) and the page's writers of days and times (Europe/Rome). */
export function useProductionPageWords(): OrderWords {
  const t = useT(NS)
  const locale = useLocale()
  return useMemo(() => orderWordsFor(t, locale), [t, locale])
}
