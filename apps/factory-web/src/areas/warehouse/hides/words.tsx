'use client'

import { useMemo, type ReactNode } from 'react'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LOTS_NAMESPACES } from '../lots/shared/model'

/**
 * The words of Hides' W2b parts (B-W2b-131: the leather dashboard, Find hides for a job, Move…, the remnant pieces, the
 * photo column): catalogue `warehouse-hides`, beside the pages' own `warehouse-lots` and the shared `stock` words, and the
 * every-day dialogs' `warehouse-daily` (a reservation's refusals).
 */

export const HIDES_NAMESPACES = [...LOTS_NAMESPACES, 'warehouse-hides', 'warehouse-daily'] as const

export function HidesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={HIDES_NAMESPACES}>{children}</WithMessages>
}

export type HideWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** A key of `warehouse-hides`; `lots:<key>` of warehouse-lots, `stock:<key>` of stock, `daily:<key>` of warehouse-daily. */
export function useHideWords(): HideWords {
  const own = useT('warehouse-hides')
  const lots = useT('warehouse-lots')
  const stock = useT('stock')
  const daily = useT('warehouse-daily')
  return useMemo<HideWords>(
    () => (key, params) =>
      key.startsWith('lots:') ? lots(key.slice(5), params) : key.startsWith('stock:') ? stock(key.slice(6), params) : key.startsWith('daily:') ? daily(key.slice(6), params) : own(key, params),
    [own, lots, stock, daily],
  )
}
