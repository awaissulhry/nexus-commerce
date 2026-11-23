'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveBus } from '../../../../shell/live/use-live'
import type { PartyRow } from '../../../parties/_shared/api'
import { problemKey } from '../../../parties/_shared/model'
import { CUSTOMERS_WORK_MAX, readCustomersWork, type CustomerWork } from './api'
import { workTouchedBy } from './model'

/** The work facts of the loaded customers: by customer (null while the first read runs), or the read's problem (a `parties` key). */
export interface CustomersWorkModel {
  readonly byParty: ReadonlyMap<string, CustomerWork> | null
  readonly problem: string | null
  /** false: some waiting replies were beyond the threads' read cap (the hint says so). */
  readonly repliesComplete: boolean
  /** Every grant of the reader's orders.view names its customers ("Your customers"). */
  readonly limited: boolean
}

/** The live changes are read again together after this pause (a burst is one read). */
export const WORK_REREAD_MS = 800

/**
 * F-CL-201 (13-backend §8.6): the work facts of the list's loaded customers — `GET /sales/orders/customers/work` per 50 ids, again
 * (coalesced, in place) after a live change of an order, a deposit, a change request, a production or a waiting thread (the Work
 * strip's own sources). Only with orders.view (`enabled`); never per row.
 */
export function useCustomersWork(api: ApiClient, rows: readonly PartyRow[], enabled: boolean): CustomersWorkModel {
  const ids = useMemo(() => rows.map((row) => row.id), [rows])
  const key = ids.join(',')
  const [model, setModel] = useState<CustomersWorkModel>({ byParty: null, problem: null, repliesComplete: true, limited: false })
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveBus(
    {
      onChange: (change) => {
        if (!workTouchedBy(change.type)) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setTick((count) => count + 1), WORK_REREAD_MS)
      },
      onReconnect: () => setTick((count) => count + 1),
    },
    enabled,
  )
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useEffect(() => {
    if (!enabled || key === '') {
      setModel({ byParty: enabled ? new Map() : null, problem: null, repliesComplete: true, limited: false })
      return
    }
    const abort = new AbortController()
    const all = key.split(',')
    const chunks = Array.from({ length: Math.ceil(all.length / CUSTOMERS_WORK_MAX) }, (_, index) => all.slice(index * CUSTOMERS_WORK_MAX, (index + 1) * CUSTOMERS_WORK_MAX))
    Promise.all(chunks.map((chunk) => readCustomersWork(api, chunk, abort.signal)))
      .then((answers) => {
        if (abort.signal.aborted) return
        const byParty = new Map<string, CustomerWork>()
        for (const answer of answers) for (const customer of answer.customers) byParty.set(customer.partyId, customer)
        setModel({ byParty, problem: null, repliesComplete: answers.every((answer) => answer.repliesComplete !== false), limited: answers.some((answer) => answer.limited === true) })
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setModel((now) => ({ ...now, problem: problemKey(error) }))
      })
    return () => abort.abort()
  }, [api, enabled, key, tick])
  return model
}
