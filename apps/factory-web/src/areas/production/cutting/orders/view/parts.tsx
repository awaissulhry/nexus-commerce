'use client'

import { useCallback, type ReactNode } from 'react'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../model'
import { ORDERS_NAMESPACE } from '../model'

/** The catalogues of the cut order screens: their own (`cutting-orders`), the list frame's. */
export function OrdersMessages({ children }: { children: ReactNode }) {
  return <WithMessages namespaces={[ORDERS_NAMESPACE, 'lists']}>{children}</WithMessages>
}

/** A phrase in the `cutting-orders` words (null stays null: a button that is not held). */
export function useSay(): (words: Phrase | null) => string | null {
  const t = useT(ORDERS_NAMESPACE)
  return useCallback((words: Phrase | null) => (words ? t(words.key, words.params) : null), [t])
}
