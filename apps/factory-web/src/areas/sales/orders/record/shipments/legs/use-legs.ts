'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserApi } from '../../../../../../lib/api/browser'
import type { ApiClient } from '../../../../../../lib/api/client'
import { useOfficeSession } from '../../../../../../lib/session/context'
import type { OfficeSession } from '../../../../../../lib/session/session'
import { readProblem } from '../../../../../warehouse/shipments/model'
import { warehouseLegs, type Leg } from './api'

/**
 * The signed-in office person, or null where the tab is drawn without one (the design index and the order page's render tests draw
 * the Shipments tab from fixtures, outside the office layout). `useOfficeSession` reads its context first, every time, then throws
 * outside the layout: the hook order stays the same on every render of one place.
 */
export function useOfficeSessionIfAny(): OfficeSession | null {
  try {
    return useOfficeSession()
  } catch {
    return null
  }
}

/** The office API of the session's company, or null without a session (nothing is read then). */
export function useOfficeApiIfAny(session: OfficeSession | null): ApiClient | null {
  const company = session?.company?.code ?? null
  const signedIn = session !== null
  return useMemo(() => (signedIn ? browserApi({ company }) : null), [signedIn, company])
}

/** The legs of an order as read: the rows, or why they could not be read (a `shipments` word); both null while reading. */
export interface LegsRead {
  readonly legs: readonly Leg[] | null
  readonly problem: string | null
  readonly reload: () => void
}

/**
 * owb-ss3 — reads `GET /shipping/warehouse-legs?salesOrderId=` for one order (shipping.view; the server Shape of owb-ss1). A later
 * read wins over an earlier one; `reload` reads again (after an act); a new `version` (the order's shipments changed) reads again.
 * No API (no session) or no order: nothing is read.
 */
export function useOrderLegs(api: ApiClient | null, salesOrderId: string | null, version: unknown = null): LegsRead {
  const [legs, setLegs] = useState<readonly Leg[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const seq = useRef(0)
  const load = useCallback(() => {
    if (!api || !salesOrderId) return
    const mine = ++seq.current
    setProblem(null)
    warehouseLegs(api, salesOrderId)
      .then((rows) => {
        if (mine === seq.current) setLegs(rows)
      })
      .catch((error: unknown) => {
        if (mine === seq.current) setProblem(readProblem(error))
      })
  }, [api, salesOrderId])
  useEffect(() => {
    load()
  }, [load, version])
  return { legs, problem, reload: load }
}
