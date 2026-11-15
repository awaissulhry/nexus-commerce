'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { unapplied, type Unapplied, type UnappliedPayment } from './api'
import { unappliedTouched } from './model'

export interface NotPlacedState {
  /** The first page's answer (its totals are the tile); null while read or failed. */
  answer: Unapplied | null
  items: UnappliedPayment[] | null
  more: boolean
  problem: string | null
}

/**
 * Payments' "Not placed on an invoice" (B-W2b-425 on B-W2b-393's unapplied queue): ONE read serves the tile (its totals) and
 * the rows (`?rows=notPlaced`, 50 a page with Show more). Live: a payment moved, a bank line accepted or taken back reads it
 * again (coalesced). Without payments.view nothing is asked.
 */
export function useNotPlaced(api: ApiClient, companyId: string | null, enabled: boolean) {
  const [state, setState] = useState<NotPlacedState>({ answer: null, items: null, more: false, problem: null })
  const cursor = useRef<number | null>(null)
  const asked = useRef(0)

  const read = useCallback(async () => {
    if (!enabled || !companyId) return
    const id = ++asked.current
    try {
      const answer = await unapplied(api, { companyId })
      if (id !== asked.current) return
      cursor.current = answer.nextCursor
      setState({ answer, items: answer.payments, more: answer.nextCursor !== null, problem: null })
    } catch (error) {
      if (id !== asked.current) return
      setState({ answer: null, items: null, more: false, problem: readProblem(error) })
    }
  }, [api, companyId, enabled])

  useEffect(() => {
    void read()
  }, [read])

  const more = useCallback(async () => {
    if (!companyId || cursor.current === null) return
    try {
      const answer = await unapplied(api, { companyId, cursor: cursor.current })
      cursor.current = answer.nextCursor
      setState((current) => ({ ...current, items: [...(current.items ?? []), ...answer.payments.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: answer.nextCursor !== null }))
    } catch (error) {
      setState((current) => ({ ...current, problem: readProblem(error) }))
    }
  }, [api, companyId])

  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (unappliedTouched(change)) reread()
    },
    () => reread(),
    enabled,
  )

  return { notPlaced: state, readNotPlaced: read, moreNotPlaced: more }
}
