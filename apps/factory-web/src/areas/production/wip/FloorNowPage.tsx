'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { countWorkOrders, getSiteWip, listWorkOrders, type SiteWip, type WorkOrderCounts, type WorkOrderRow } from '../_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem } from '../_shared/model'
import { FloorNowView, type FloorNowModel } from './view/FloorNowView'

/**
 * `/w/<company>/production/floor` (SCR-073): reads the open work orders' WIP at the person's sites (GET
 * /production/scans/wip), the tiles' counts and the late work orders, and reads them again when the floor reports (a
 * burst of scans is one read). Nothing per person or station is asked for: the API serves none.
 */
export function FloorNowPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/production\/floor\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [wip, setWip] = useState<{ value: SiteWip | null; problem: string | null }>({ value: null, problem: null })
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [late, setLate] = useState<{ items: WorkOrderRow[] | null; problem: string | null }>({ items: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)

  const load = useCallback(async () => {
    getSiteWip(api)
      .then((value) => {
        setWip({ value, problem: null })
        setAsOf(new Date().toISOString())
      })
      .catch((error: unknown) => setWip({ value: null, problem: readProblem(error) }))
    countWorkOrders(api)
      .then(setCounts)
      .catch(() => setCounts(null))
    listWorkOrders(api, { late: true, limit: 20 })
      .then((page) => setLate({ items: page.workOrders, problem: null }))
      .catch((error: unknown) => setLate({ items: null, problem: readProblem(error) }))
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 1500)
  const live = useLive(
    (change) => {
      if (liveTouches(change)) reread()
    },
    () => void load(),
  )

  const model: FloorNowModel = { prefix, can, wip, counts, late, asOf, live }
  return <FloorNowView model={model} actions={{ onRetry: () => void load() }} />
}
