'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { getMethod, getWorkOrderCosts, type MethodView, type WorkOrderCostRow, type CostTiles } from '../api'
import { addressOf, closedIn, costingCanOf, periodOf, readProblem, romeToday, rowsQuery } from '../model'
import { CostingPrintView } from './view/CostingPrintView'

/** At most this many pages of 50 work orders on paper (the note says when there are more). */
const PAGES = 10

/**
 * `/w/<company>/finance/costing/print?site=&rows=&q=&month=` (SCR-154 tab:print, "Variance report (print)"): the work
 * orders of the scope with standard vs actual, read once (up to 500), drawn for paper with the scope written at the top.
 * Opened in a new tab from the page's ⋯.
 */
export function CostingPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const address = useMemo(() => addressOf(params), [params])
  const can = useMemo(() => costingCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const today = romeToday()
  const period = useMemo(() => periodOf(address.month, today), [address.month, today])
  const [read, setRead] = useState<{ rows: WorkOrderCostRow[] | null; tiles: CostTiles | null; more: boolean; problem: string | null }>({ rows: null, tiles: null, more: false, problem: null })
  const [method, setMethod] = useState<MethodView | null>(null)
  const [readAt, setReadAt] = useState<string | null>(null)

  useEffect(() => {
    if (!can.view) return
    let live = true
    const run = async () => {
      const rows: WorkOrderCostRow[] = []
      let cursor: string | null = null
      let tiles: CostTiles | null = null
      let pages = 0
      do {
        const page = await getWorkOrderCosts(api, rowsQuery(address, companyId, cursor))
        tiles ??= page.tiles
        rows.push(...(address.rows === 'closed' ? page.rows.filter((row) => closedIn(row, period)) : page.rows))
        cursor = page.nextCursor
        pages += 1
      } while (cursor && pages < PAGES)
      return { rows, tiles, more: cursor !== null }
    }
    run()
      .then((value) => {
        if (!live) return
        setRead({ ...value, problem: null })
        setReadAt(new Date().toISOString())
      })
      .catch((error: unknown) => live && setRead({ rows: null, tiles: null, more: false, problem: readProblem(error) }))
    getMethod(api, companyId)
      .then((value) => live && setMethod(value))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, address, can.view, companyId, period])

  return <CostingPrintView model={{ person: session.user.displayName, company: session.company?.name ?? '', can, address, period, read, method, readAt }} />
}
