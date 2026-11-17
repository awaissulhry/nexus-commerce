'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { partyOf, withParty, type CustomerFilterState, type CustomerOption, type CustomerView } from './model'

/**
 * F-PR-02 — the customer filter of one production page (the container's part; the view draws `CustomerFilter`): the options
 * the API gives for the page's own permission (GET /production/customers?view=), the customer the address names (`?party=`),
 * and the pick, which rewrites the address (every list on the page, its tiles and its export follow it).
 */

const answerSchema = z.object({
  customers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  everyCustomer: z.boolean(),
})

export function getProductionCustomers(api: ApiClient, view: CustomerView, signal?: AbortSignal): Promise<{ customers: CustomerOption[]; everyCustomer: boolean }> {
  return api.get('/production/customers', { query: { view }, schema: answerSchema, signal })
}

export interface ProductionCustomers {
  readonly state: CustomerFilterState
  /** The API filter for the page's reads (`partyId`), or undefined for every customer. */
  readonly partyId: string | undefined
  readonly onPick: (party: string | null) => void
}

export function useProductionCustomers(view: CustomerView): ProductionCustomers {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const party = partyOf(params)
  const [read, setRead] = useState<{ options: readonly CustomerOption[] | null; everyCustomer: boolean | null }>({ options: null, everyCustomer: null })

  useEffect(() => {
    const controller = new AbortController()
    getProductionCustomers(api, view, controller.signal)
      .then((answer) => setRead({ options: answer.customers, everyCustomer: answer.everyCustomer }))
      .catch(() => {
        if (!controller.signal.aborted) setRead({ options: null, everyCustomer: null })
      })
    return () => controller.abort()
  }, [api, view])

  const names = session.permissions.includes('parties.view')
  const state = useMemo<CustomerFilterState>(() => ({ options: read.options, everyCustomer: read.everyCustomer, party, names }), [read, party, names])
  const query = params?.toString() ?? ''
  const onPick = useCallback(
    (next: string | null) => router.replace(withParty(`${pathname}${query ? `?${query}` : ''}`, next), { scroll: false }),
    [router, pathname, query],
  )
  return { state, partyId: party ?? undefined, onPick }
}
