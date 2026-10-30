'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { countWorkOrders, getSiteWip, listWorkOrders, type SiteWip, type WorkOrderCounts, type WorkOrderRow } from '../_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem } from '../_shared/model'
import { getLines, type LinesOverview } from '../reports/api'
import { lineScopeOf, stepLine } from '../reports/model'
import { FloorNowView, type FloorNowModel } from './view/FloorNowView'

/**
 * `/w/<company>/production/floor` (SCR-073): reads the open work orders' WIP at the person's sites (GET
 * /production/scans/wip), the tiles' counts, the late work orders and (B-W2a-38) each line at a glance (GET
 * /production/reports/lines), and reads them again when the floor reports (a burst of scans is one read). A line card
 * sets the line scope in the address (`?line=<id>`); [ and ] step to the previous and next line. Nothing per person is
 * asked for: the API serves none (per station only "nobody signed in" and machines down, Owner F2).
 */
export function FloorNowPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/floor\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const lineScope = useMemo(() => lineScopeOf(params), [params])
  const [wip, setWip] = useState<{ value: SiteWip | null; problem: string | null }>({ value: null, problem: null })
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [late, setLate] = useState<{ items: WorkOrderRow[] | null; problem: string | null }>({ items: null, problem: null })
  const [lines, setLines] = useState<{ value: LinesOverview | null; problem: string | null }>({ value: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)

  const loadLines = useCallback(() => {
    getLines(api)
      .then((value) => setLines({ value, problem: null }))
      .catch((error: unknown) => setLines({ value: null, problem: readProblem(error) }))
  }, [api])

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
    loadLines()
  }, [api, loadLines])

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

  const setScope = useCallback(
    (lineId: string | null) => router.replace(`${prefix}/production/floor${lineId ? `?line=${encodeURIComponent(lineId)}` : ''}`, { scroll: false }),
    [router, prefix],
  )

  // [ and ] (design production.floor keyboard): the previous / next line, not while typing.
  const cards = lines.value?.lines ?? null
  useEffect(() => {
    if (!cards || cards.length === 0) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== '[' && event.key !== ']')) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const next = stepLine(cards, lineScope, event.key === ']' ? 1 : -1)
      if (next) {
        event.preventDefault()
        setScope(next)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [cards, lineScope, setScope])

  const model: FloorNowModel = { prefix, can, wip, counts, late, asOf, live, lines, lineScope }
  return <FloorNowView model={model} actions={{ onRetry: () => void load(), onLine: setScope, onRetryLines: loadLines }} />
}
