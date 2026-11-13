'use client'

import { useCallback, type ReactNode } from 'react'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { PRICE_DEPTH_NS, type Words } from './model'

/** This step's catalogue beside W1's `sales` one (the quote record's words it reuses). */
export function PriceDepthMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['sales', PRICE_DEPTH_NS]}>{children}</WithMessages>
}

/** The catalogue's translator, `sales`, and `say` for a Words (the `sales` catalogue when it names it). */
export function usePriceWords() {
  const t = useT(PRICE_DEPTH_NS)
  const sales = useT('sales')
  const say = useCallback((words: Words | null | undefined): string => (words ? (words.ns === 'sales' ? sales(words.key, words.params) : t(words.key, words.params)) : ''), [t, sales])
  return { t, sales, say }
}
