'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { boardOf, defaultLayout } from '@nexus/factory-domain/insights/dashboards/boards'
import type { SectionLayoutValue } from '@nexus/ui/patterns'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useLiveBus } from '../../../shell/live/use-live'
import { getBoards, getByCompany, getLayout, getNeedsAction, getNumbers, getTrends, getWip, resetLayout, saveLayout, type Boards, type ByCompany, type DashLayout, type DashScope, type NeedsAction, type Numbers, type Trends, type Wip } from './api'
import { boardShown, DASHBOARD_LIVE_EVENTS, dashboardAddressOf, dashboardsCanOf, dashboardsHref, layoutFrom, PRESENT_REFRESH_MS, readProblem, writeProblem } from './model'
import { DashboardsView, type Read } from './view/DashboardsView'

const LOADING = { status: 'loading' } as const

/**
 * `/w/<company>/home/dashboards?board=&period=&company=&site=` (SCR-031 / SCR-103) and `/w/<company>/home/dashboards/present?…`
 * (SCR-490, Present in its own window): reads the picker once (GET /insights/dashboards), then the dashboard shown — its numbers,
 * Needs action, the on-time weeks, the work in progress, the view by company and site and my arrangement, each panel on its own
 * (a panel the person may not see is never asked) — keeps the dashboard, the period and the scope in the address, reads the
 * numbers again when the metric layer says the facts were rebuilt (`facts.rebuilt`, `kpi.changed`), and saves my arrangement on
 * the server (PUT / DELETE …/layout). Present reads everything again every five minutes. Without home.kpis.view the page says
 * so and asks the API nothing.
 */
export function DashboardsPage({ mode = 'page' }: { mode?: 'page' | 'present' }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/home\/dashboards(\/present)?\/?$/, '')
  const can = useMemo(() => dashboardsCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => dashboardAddressOf(params), [params])

  const [boards, setBoards] = useState<Read<Boards>>(LOADING)
  const [numbers, setNumbers] = useState<Read<Numbers>>(LOADING)
  const [needs, setNeeds] = useState<Read<NeedsAction>>(LOADING)
  const [trends, setTrends] = useState<Read<Trends>>(LOADING)
  const [wip, setWip] = useState<Read<Wip>>(LOADING)
  const [byCompany, setByCompany] = useState<Read<ByCompany>>(LOADING)
  const [layout, setLayout] = useState<Read<DashLayout>>(LOADING)
  const [arranging, setArranging] = useState(false)
  const [arrange, setArrange] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null })
  const [keysOpen, setKeysOpen] = useState(false)

  const loadBoards = useCallback(async () => {
    if (!can.view) return
    setBoards(LOADING)
    try {
      setBoards({ status: 'ready', value: await getBoards(api) })
    } catch (error) {
      setBoards({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view])

  useEffect(() => {
    void loadBoards()
  }, [loadBoards])

  const board = boards.status === 'ready' ? boardShown(boards.value.boards, address) : null
  const scope: DashScope = useMemo(() => ({ companyId: address.company, siteId: address.site }), [address.company, address.site])

  /** One panel read into its state; a newer read of the same panel wins over an older one still on its way. */
  const turns = useRef<Record<string, number>>({})
  const read = useCallback(async <T,>(panel: string, set: (value: Read<T>) => void, load: () => Promise<T>, quiet = false) => {
    const turn = (turns.current[panel] = (turns.current[panel] ?? 0) + 1)
    if (!quiet) set(LOADING)
    try {
      const value = await load()
      if (turns.current[panel] === turn) set({ status: 'ready', value })
    } catch (error) {
      if (turns.current[panel] === turn) set({ status: 'error', problem: readProblem(error) })
    }
  }, [])

  const has = useCallback((panel: string) => board?.panels.includes(panel as never) ?? false, [board])
  const loadNumbers = useCallback((quiet = false) => (board ? read('numbers', setNumbers, () => getNumbers(api, board.key, { ...scope, period: address.period }), quiet) : undefined), [api, board, scope, address.period, read])
  const loadNeeds = useCallback((quiet = false) => (board && has('needs-action') ? read('needs', setNeeds, () => getNeedsAction(api, scope), quiet) : undefined), [api, board, has, scope, read])
  const loadTrends = useCallback((quiet = false) => (board && has('trends') ? read('trends', setTrends, () => getTrends(api, scope), quiet) : undefined), [api, board, has, scope, read])
  const loadWip = useCallback((quiet = false) => (board && has('wip') ? read('wip', setWip, () => getWip(api, scope), quiet) : undefined), [api, board, has, scope, read])
  const loadByCompany = useCallback((quiet = false) => (board && has('by-company') ? read('byCompany', setByCompany, () => getByCompany(api, board.key, { period: address.period }), quiet) : undefined), [api, board, has, address.period, read])
  const loadLayout = useCallback(() => (board ? read('layout', setLayout, () => getLayout(api, board.key)) : undefined), [api, board, read])

  useEffect(() => void loadNumbers(), [loadNumbers])
  useEffect(() => void loadNeeds(), [loadNeeds])
  useEffect(() => void loadTrends(), [loadTrends])
  useEffect(() => void loadWip(), [loadWip])
  useEffect(() => void loadByCompany(), [loadByCompany])
  useEffect(() => void loadLayout(), [loadLayout])

  // The facts were rebuilt (hourly, or after an order, a shipment, a scan…) or a KPI's words changed: read the numbers again,
  // quietly (the last ones stay until the new ones arrive), a second after the last event (a rebuild sends one per company).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void loadNumbers(true)
      void loadTrends(true)
      void loadByCompany(true)
    }, 1000)
  }, [loadNumbers, loadTrends, loadByCompany])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useLiveBus({ onChange: (change) => (DASHBOARD_LIVE_EVENTS.includes(change.type) ? later() : undefined), onReconnect: later }, can.view && board !== null)

  // Present: everything read again on its own, every five minutes (design tab:present "auto-refreshing").
  useEffect(() => {
    if (mode !== 'present' || !board) return
    const every = setInterval(() => {
      void loadNumbers(true)
      void loadNeeds(true)
      void loadTrends(true)
      void loadWip(true)
      void loadByCompany(true)
    }, PRESENT_REFRESH_MS)
    return () => clearInterval(every)
  }, [mode, board, loadNumbers, loadNeeds, loadTrends, loadWip, loadByCompany])

  const serverPanels = layout.status === 'ready' ? layout.value.panels : board ? defaultLayout(boardOf(board.key)!) : []
  const version = layout.status === 'ready' ? layout.value.version : 0

  const onArranged = async (value: SectionLayoutValue): Promise<string | null> => {
    if (!board) return null
    setArrange({ busy: true, problem: null })
    try {
      const saved = await saveLayout(api, board.key, { panels: layoutFrom(value, serverPanels), version })
      setLayout({ status: 'ready', value: saved })
      setArrange({ busy: false, problem: null })
      setArranging(false)
      return null
    } catch (error) {
      const problem = writeProblem(error)
      setArrange({ busy: false, problem })
      void loadLayout()
      return problem
    }
  }

  const onReset = () => {
    if (!board || layout.status !== 'ready' || !layout.value.saved) return
    setArrange({ busy: true, problem: null })
    resetLayout(api, board.key, layout.value.version)
      .then((saved) => {
        setLayout({ status: 'ready', value: saved })
        setArrange({ busy: false, problem: null })
        setArranging(false)
      })
      .catch((error: unknown) => {
        setArrange({ busy: false, problem: writeProblem(error) })
        void loadLayout()
      })
  }

  return (
    <DashboardsView
      model={{ can, prefix, address, boards, board, numbers, needs, trends, wip, byCompany, layout, built: OFFICE_PAGES, mode, arranging, arrange, keysOpen }}
      actions={{
        onAddress: (next) => router.replace(dashboardsHref(prefix, { ...next, board: next.board ?? board?.key ?? null }), { scroll: false }),
        onBoard: (key) => router.replace(dashboardsHref(prefix, { ...address, board: key }), { scroll: false }),
        onRetry: (panel) => {
          if (panel === 'boards') void loadBoards()
          else if (panel === 'numbers') void loadNumbers()
          else if (panel === 'needs') void loadNeeds()
          else if (panel === 'trends') void loadTrends()
          else if (panel === 'wip') void loadWip()
          else void loadByCompany()
        },
        onOpen: (href) => router.push(href),
        onArrange: (open) => {
          setArrange({ busy: false, problem: null })
          setArranging(open)
        },
        onArranged,
        onReset,
        onKeys: setKeysOpen,
      }}
    />
  )
}
