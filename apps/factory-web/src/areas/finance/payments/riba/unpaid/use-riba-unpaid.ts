'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useCoalesced, useLive } from '../../../_shared/hooks'
import { readProblem } from '../../../_shared/model'
import { ribaUnpaid, type RibaUnpaid } from '../api'

export interface RibaUnpaidState {
  value: RibaUnpaid | null
  problem: string | null
}

/** A live event that changes what came back unpaid: a receipt settled, a batch moved, a payment placed. */
export const ribaUnpaidTouched = (change: { type: string }): boolean => change.type === 'riba_item.settled' || change.type === 'riba_batch.changed' || change.type.startsWith('payment.')

/**
 * Payments' "Ri.Ba. unpaid" (B-W2b-425 on B-W2b-402's API): ONE read serves the tile (per currency) and the rows
 * (`?rows=ribaUnpaid`). Live: a settled receipt, a batch or a payment reads it again (coalesced). Without receivables.view
 * nothing is asked.
 */
export function useRibaUnpaid(api: ApiClient, companyId: string | null, enabled: boolean) {
  const [state, setState] = useState<RibaUnpaidState>({ value: null, problem: null })
  const asked = useRef(0)
  const read = useCallback(async () => {
    if (!enabled || !companyId) return
    const id = ++asked.current
    try {
      const value = await ribaUnpaid(api, companyId)
      if (id === asked.current) setState({ value, problem: null })
    } catch (error) {
      if (id === asked.current) setState({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, enabled])
  useEffect(() => {
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (ribaUnpaidTouched(change)) reread()
    },
    () => reread(),
    enabled,
  )
  return { ribaUnpaid: state, readRibaUnpaid: read }
}

/** The tile "Ri.Ba. unpaid": the euro tile (else the first), how many came back, what they still owe (null: no grain). */
export function ribaUnpaidTile(value: RibaUnpaid | null): { count: number; open: number | null; currency: string; others: number } | null {
  if (!value) return null
  const tile = value.tiles.find((entry) => entry.currency === 'EUR') ?? value.tiles[0]
  if (!tile) return { count: 0, open: 0, currency: 'EUR', others: 0 }
  return { count: tile.count, open: tile.open ?? null, currency: tile.currency, others: value.tiles.length - 1 }
}
