'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { listAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { approveQuote, decisionProblem, fetchFlow, fetchPanel, fetchQuoteReview, fetchToday, readProblem, rejectQuote } from './api'
import { panelRow, queueItem } from './links'
import { useTodayLive } from './live'
import {
  DECIDED_HERE,
  freshCount,
  newVerbsFor,
  nextAfter,
  wantsChange,
  type FlowAnswer,
  type FlowLensView,
  type Loaded,
  type Notice,
  type PanelView,
  type ReviewState,
  type TodayAnswer,
  type Category,
  type TodayItem,
  type TodayViewModel,
} from './model'
import { panelsFor } from './panels'
import { TodayView } from './view/TodayView'

interface QueueState {
  readonly answer: TodayAnswer
  readonly items: readonly TodayItem[]
  readonly cursor: string | null
  readonly loadingMore: boolean
  /** A fresher first page a live change brought, shown when the person asks ("N new · Show"). */
  readonly pending: TodayAnswer | null
}

/**
 * `/w/<company>/home/today` (SCR-029): loads Today through the API client — the ranked rows and tiles (GET
 * /home/today, `?kind=` the pressed tile), the flow strip (GET /home/flow) and the lists of the picked lens (each
 * panel's own list route) — keeps `?kind=` and `?open=` in the address, reads a section again when the live stream
 * names one of its events (new rows wait behind "N new · Show"; rows never move while the decide modal is open), and
 * decides a quote approval with the quotes module's own approve and reject (the quote's version as read).
 */
export function Today() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions])
  const allowed = permissions.has('home.view')
  const prefix = companyPrefix(session.company?.code ?? '')
  const kind = search.get('kind')
  const tileParam = search.get('tile')
  const tile: Category | null = tileParam === 'APPROVAL' || tileParam === 'ALERT' ? tileParam : null
  const open = search.get('open')

  const [queue, setQueue] = useState<Loaded<QueueState>>({ status: 'loading' })
  const [flow, setFlow] = useState<Loaded<readonly FlowLensView[]> | null>({ status: 'loading' })
  const [flowEvents, setFlowEvents] = useState<readonly string[]>([])
  const [lens, setLens] = useState<string | null>(null)
  const [panels, setPanels] = useState<Readonly<Record<string, PanelView['state']>>>({})
  const [reviews, setReviews] = useState<Readonly<Record<string, ReviewState>>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const openRef = useRef(open)
  openRef.current = open
  const kindRef = useRef(kind)
  kindRef.current = kind
  const tileRef = useRef(tile)
  tileRef.current = tile
  const queueSeq = useRef(0)

  const setParams = useCallback(
    (changes: Readonly<Record<string, string | null>>) => {
      const params = new URLSearchParams(search.toString())
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) params.delete(name)
        else params.set(name, value)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname, search],
  )
  const setParam = useCallback((name: string, value: string | null) => setParams({ [name]: value }), [setParams])

  // ---- reads ---------------------------------------------------------------------------------------------------------
  const loadQueue = useCallback(async () => {
    const mine = ++queueSeq.current
    try {
      const answer = await fetchToday(api, { kind: kindRef.current, category: tileRef.current })
      if (mine !== queueSeq.current) return
      setNow(Date.now())
      setQueue({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
    } catch (error) {
      if (mine === queueSeq.current) setQueue({ status: 'error', problem: readProblem(error) })
    }
  }, [api])

  /** A live change: a fresher first page; new rows wait behind "N new · Show", and nothing moves under an open row. */
  const refreshQueue = useCallback(async () => {
    const mine = ++queueSeq.current
    try {
      const answer = await fetchToday(api, { kind: kindRef.current, category: tileRef.current })
      if (mine !== queueSeq.current) return
      setNow(Date.now())
      setQueue((current) => {
        if (current.status !== 'ready') return { status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } }
        const fresh = freshCount(current.data.items, answer.items)
        if (fresh > 0 || openRef.current !== null) return { status: 'ready', data: { ...current.data, pending: answer } }
        return { status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } }
      })
    } catch {
      // A failed refresh keeps what is shown; the next change or reconnect reads again.
    }
  }, [api])

  const loadMore = useCallback(async () => {
    if (queue.status !== 'ready' || queue.data.cursor === null) return
    const cursor = queue.data.cursor
    setQueue({ status: 'ready', data: { ...queue.data, loadingMore: true } })
    try {
      const page = await fetchToday(api, { kind: kindRef.current, category: tileRef.current, cursor })
      setQueue((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: [...current.data.items, ...page.items], cursor: page.nextCursor, loadingMore: false } } : current))
    } catch (error) {
      setQueue((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, loadingMore: false } } : current))
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }, [api, queue])

  const loadFlow = useCallback(async () => {
    try {
      const answer: FlowAnswer = await fetchFlow(api)
      if (answer.lenses.length === 0) {
        setFlow(null)
        return
      }
      setFlowEvents(answer.lenses.flatMap((entry) => entry.live.events))
      setFlow({
        status: 'ready',
        data: answer.lenses.map((entry) => ({
          lens: entry.lens,
          label: entry.label,
          complete: entry.complete,
          stages: entry.stages.map((stage) => {
            const address = listAddress(entry.list, stage.filter, OFFICE_PAGES)
            return { key: stage.key, label: stage.label, count: stage.count, late: stage.late, oldestDays: stage.oldestDays, href: address ? `${prefix}${address}` : null, inexact: !stage.exact }
          }),
        })),
      })
      setLens((current) => current ?? answer.lenses[0]?.lens ?? null)
    } catch (error) {
      setFlow({ status: 'error', problem: readProblem(error) })
    }
  }, [api, prefix])

  const shownPanels = useMemo(() => panelsFor(permissions, lens), [permissions, lens])
  const loadPanels = useCallback(async () => {
    await Promise.all(
      shownPanels.map(async (panel) => {
        try {
          const page = await fetchPanel(api, panel)
          setPanels((current) => ({ ...current, [panel.id]: { status: 'ready', data: { rows: page.rows.map((row) => panelRow(row, prefix)), more: page.more } } }))
        } catch (error) {
          setPanels((current) => ({ ...current, [panel.id]: { status: 'error', problem: readProblem(error) } }))
        }
      }),
    )
  }, [api, shownPanels, prefix])

  const loadReview = useCallback(
    async (item: TodayItem) => {
      setReviews((current) => ({ ...current, [item.key]: { status: 'loading' } }))
      try {
        const review = await fetchQuoteReview(api, item.record.id)
        setReviews((current) => ({ ...current, [item.key]: { status: 'ready', data: review } }))
      } catch (error) {
        setReviews((current) => ({ ...current, [item.key]: { status: 'error', problem: readProblem(error) } }))
      }
    },
    [api],
  )

  useEffect(() => {
    if (!allowed) return
    setQueue({ status: 'loading' })
    void loadQueue()
  }, [allowed, kind, tile, loadQueue])
  useEffect(() => {
    if (allowed) void loadFlow()
  }, [allowed, loadFlow])
  useEffect(() => {
    if (allowed) void loadPanels()
  }, [allowed, loadPanels])

  const items = queue.status === 'ready' ? queue.data.items : []
  const openItem = open ? (items.find((item) => item.key === open) ?? null) : null
  useEffect(() => {
    if (openItem && DECIDED_HERE.has(openItem.kind) && reviews[openItem.key] === undefined) void loadReview(openItem)
  }, [openItem, reviews, loadReview])

  // ---- live ------------------------------------------------------------------------------------------------------------
  const events = useMemo(() => new Set([...(queue.status === 'ready' ? queue.data.answer.live.events : []), ...flowEvents]), [queue, flowEvents])
  const pendingRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readAgain = useCallback(() => {
    // Several events of one change arrive together: one read for them (half a second).
    if (pendingRead.current) clearTimeout(pendingRead.current)
    pendingRead.current = setTimeout(() => {
      pendingRead.current = null
      void refreshQueue()
      void loadFlow()
      void loadPanels()
    }, 500)
  }, [refreshQueue, loadFlow, loadPanels])
  useEffect(() => () => (pendingRead.current ? clearTimeout(pendingRead.current) : undefined), [])
  const live = useTodayLive({ onChange: (type) => wantsChange(events, type) && readAgain(), onReconnect: readAgain }, allowed)

  // ---- decisions -------------------------------------------------------------------------------------------------------
  const decide = async (key: string, run: (review: Parameters<typeof approveQuote>[1]) => Promise<unknown>, done: Notice): Promise<boolean> => {
    const state = reviews[key]
    if (state?.status !== 'ready') return false
    const keys = items.map((item) => item.key)
    setBusy(true)
    setNotice(null)
    try {
      await run(state.data)
      setNotice(done)
      setReviews((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      // After a decision the next row opens (design: "after a decision the next item opens").
      setParam('open', nextAfter(keys, key))
      await loadQueue()
      return true
    } catch (error) {
      const problem = decisionProblem(error)
      setNotice({ key: problem.key, tone: problem.tone })
      const item = items.find((entry) => entry.key === key)
      if (problem.reload && item) void loadReview(item)
      return false
    } finally {
      setBusy(false)
    }
  }

  // ---- the view model --------------------------------------------------------------------------------------------------
  const model: TodayViewModel = {
    access: allowed ? 'open' : 'refused',
    now,
    live,
    tile,
    kind,
    queue:
      queue.status === 'ready'
        ? {
            status: 'ready',
            data: {
              asOf: queue.data.answer.asOf,
              total: queue.data.answer.total,
              needYou: queue.data.answer.counts.total,
              now: queue.data.answer.counts.now,
              tiles: queue.data.answer.counts.tiles,
              kindLabels: Object.fromEntries(queue.data.answer.counts.byKind.map((entry) => [entry.kind, entry.label])),
              items: queue.data.items.map((item) => queueItem(item, prefix)),
              more: queue.data.cursor !== null,
              loadingMore: queue.data.loadingMore,
              fresh: queue.data.pending ? Math.max(1, freshCount(queue.data.items, queue.data.pending.items)) : 0,
            },
          }
        : queue,
    flow,
    lens,
    panels: shownPanels.map((panel) => ({
      id: panel.id,
      titleKey: `today.panels.${panel.id}.title`,
      emptyKey: `today.panels.${panel.id}.empty`,
      state: panels[panel.id] ?? { status: 'loading' },
      seeAllHref: ((address) => (address ? `${prefix}${address}` : null))(listAddress(panel.path, panel.query, OFFICE_PAGES)),
    })),
    newVerbs: newVerbsFor(permissions, OFFICE_PAGES, prefix),
    printHref: `${prefix}/home/today/print${tile ? `?tile=${tile}` : kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
    open,
    reviews,
    busy,
    notice,
  }

  return (
    <TodayView
      model={model}
      actions={{
        onTile: (next) => {
          setNotice(null)
          // A tile drives the list; a kind deep link gives way to it.
          setParams({ tile: next, kind: null })
        },
        onRetry: (section) => {
          if (section === 'queue') {
            setQueue({ status: 'loading' })
            void loadQueue()
          } else if (section === 'flow') {
            setFlow({ status: 'loading' })
            void loadFlow()
          } else void loadPanels()
        },
        onMore: () => void loadMore(),
        onShowFresh: () => {
          if (queue.status !== 'ready' || !queue.data.pending) return
          const answer = queue.data.pending
          setQueue({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
        },
        onOpen: (key) => {
          setNotice(null)
          setParam('open', key)
        },
        onLens: (next) => {
          setPanels({})
          setLens(next)
        },
        onDismissNotice: () => setNotice(null),
        onApprove: (key, note) => decide(key, (review) => approveQuote(api, review, note), { key: 'today.decide.approved', tone: 'success' }),
        onReject: (key, reason) => decide(key, (review) => rejectQuote(api, review, reason), { key: 'today.decide.rejected', tone: 'success' }),
        onRetryReview: (key) => {
          const item = items.find((entry) => entry.key === key)
          if (item) void loadReview(item)
        },
      }}
    />
  )
}
