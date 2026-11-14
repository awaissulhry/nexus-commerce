'use client'

import { useCallback } from 'react'
import type { Translate } from '../../../../lib/i18n/messages'
import { useScopedT, useT } from '../../../../lib/i18n/provider'

/** The catalogues the accounting screens draw from: the W2a export's and the accountant's bridge's (B-W2b-426). */
export const ACCOUNTING_NAMESPACES = ['finance-accounting', 'finance-accounting-depth', 'finance', 'lists'] as const

/**
 * B-W2b-426 — one translator over the accounting export's words (`finance-accounting`) and the bridge's
 * (`finance-accounting-depth`: the account mapping, the closed work orders and the journals, the integrity checks, the
 * final close). Their keys never meet (the bridge's are its own: `mapping.*`, `journals.*`, `integrity.*`, `hard.*`, the
 * new `sum.*` and `fix.*`), so a key the export's catalogue lacks is read from the bridge's. A `namespace:key` key (the
 * step-up's `finance:stepUp.problem.*`) is read from that namespace. Both catalogues must be loaded (ACCOUNTING_NAMESPACES).
 */
export function useAccountingWords(): Translate {
  const t = useScopedT('finance-accounting')
  const w = useT('finance-accounting-depth')
  return useCallback<Translate>(
    (key, params) => {
      if (key.includes(':')) return t(key, params)
      const own = t(key, params)
      return own === key ? w(key, params) : own
    },
    [t, w],
  )
}
