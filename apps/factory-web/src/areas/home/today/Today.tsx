'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import {
  acknowledgeRow,
  actionProblem,
  approveQuote,
  assignRow,
  decisionProblem,
  fetchAlertRecord,
  fetchAssignees,
  fetchComingUp,
  fetchFlow,
  fetchHandled,
  fetchLayout,
  fetchPanel,
  fetchQuoteReview,
  fetchToday,
  readProblem,
  rejectQuote,
  resolveRow,
  saveLayout,
  setMentionDone,
  setTaskStatus,
  snoozeMention,
  snoozeRow,
  snoozeTask,
} from './api'
import { handledView, panelRow, queueItem } from './links'
import { useTodayLive } from './live'
import { fetchNumbers, type KeyNumbers } from './numbers/api'
import {
  DECIDED_HERE,
  DEFAULT_LAYOUT,
  freshCount,
  isCategory,
  snoozeTarget,
  tileQuery,
  TODAY_INCLUDE,
  W2A_TILES,
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
  type ComingUpAnswer,
  type ComingUpView,
  type Tile,
  type TodayDialog,
  type TodayItem,
  type TodayLayout,
  type TodayViewModel,
} from './model'
import { PANELS, panelsFor } from './panels'
import { TodayView, type DialogRequest } from './view/TodayView'

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
 *
 * The alert verbs (API insights/actions): Acknowledge, Assign to (the people GET …/assignees names), Resolve with a note —
 * each with the row's condition and version as read; a refusal says why and the list is read again. "Handled today"
 * (GET /home/today/handled) and "Arrange Today" (GET|PUT /home/today/layout: the person's own, its version as read).
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
  const tile: Category | null = isCategory(tileParam) ? tileParam : null
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
  const [layout, setLayout] = useState<{ readonly layout: TodayLayout; readonly version: number }>({ layout: DEFAULT_LAYOUT, version: 0 })
  const [dialog, setDialog] = useState<TodayDialog | null>(null)
  const [coming, setComing] = useState<Loaded<ComingUpView>>({ status: 'loading' })
  // B-W2a-79: My numbers (GET /home/numbers), read again with the page at most once a minute.
  const [numbers, setNumbers] = useState<{ value: KeyNumbers | null; problem: string | null }>({ value: null, problem: null })
  const numbersReadAt = useRef(0)
  const [comingEvents, setComingEvents] = useState<readonly string[]>([])
  const [alertRecords, setAlertRecords] = useState<Readonly<Record<string, Loaded<string>>>>({})
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const openRef = useRef(open)
  openRef.current = open
  const kindRef = useRef(kind)
  kindRef.current = kind
  const tileRef = useRef(tile)
  tileRef.current = tile
  const queueSeq = useRef(0)
  const lensPicked = useRef(false)

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
      const answer = await fetchToday(api, { kind: kindRef.current, ...tileQuery(tileRef.current), include: TODAY_INCLUDE })
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
      const answer = await fetchToday(api, { kind: kindRef.current, ...tileQuery(tileRef.current), include: TODAY_INCLUDE })
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
      const page = await fetchToday(api, { kind: kindRef.current, ...tileQuery(tileRef.current), include: TODAY_INCLUDE, cursor })
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
      // The person's main lens first ("My main role"), else the first they have.
      const main = layoutRef.current.layout.mainLens
      setLens((current) => current ?? (answer.lenses.some((entry) => entry.lens === main) ? main : (answer.lenses[0]?.lens ?? null)))
    } catch (error) {
      setFlow({ status: 'error', problem: readProblem(error) })
    }
  }, [api, prefix])

  const loadNumbers = useCallback(async () => {
    numbersReadAt.current = Date.now()
    try {
      setNumbers({ value: await fetchNumbers(api), problem: null })
    } catch (error) {
      setNumbers((current) => ({ value: current.value, problem: readProblem(error) }))
    }
  }, [api])

  // W2a: Coming up (my next five working days); each item opens its record.
  const loadComing = useCallback(async () => {
    try {
      const answer: ComingUpAnswer = await fetchComingUp(api)
      setComingEvents(answer.live.events)
      setComing({
        status: 'ready',
        data: {
          calendar: answer.calendar !== null,
          complete: answer.complete.every((entry) => entry.complete),
          days: answer.days.map((day) => ({
            date: day.date,
            working: day.working,
            items: day.items.map((item) => ({ kind: item.kind, label: item.record.label, words: item.words, href: `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId, siteId: item.siteId }, OFFICE_PAGES)}` })),
          })),
        },
      })
    } catch (error) {
      setComing({ status: 'error', problem: readProblem(error) })
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
    if (allowed) void loadComing()
  }, [allowed, loadComing])
  useEffect(() => {
    if (allowed) void loadNumbers()
  }, [allowed, loadNumbers])
  useEffect(() => {
    if (allowed) void loadPanels()
  }, [allowed, loadPanels])

  const loadLayout = useCallback(async () => {
    try {
      const answer = await fetchLayout(api)
      setLayout({ layout: answer.layout, version: answer.version })
      // A main lens saved earlier picks the lens once the layout is known, unless the person picked one meanwhile.
      if (answer.layout.mainLens && !lensPicked.current) setLens(answer.layout.mainLens)
    } catch {
      // Unreadable: the design's order is drawn; Arrange saves over it (a stale version is refused and read again).
    }
  }, [api])
  useEffect(() => {
    if (allowed) void loadLayout()
  }, [allowed, loadLayout])

  const items = queue.status === 'ready' ? queue.data.items : []
  const openItem = open ? (items.find((item) => item.key === open) ?? null) : null
  useEffect(() => {
    if (openItem && DECIDED_HERE.has(openItem.kind) && reviews[openItem.key] === undefined) void loadReview(openItem)
  }, [openItem, reviews, loadReview])
  // W2a: an exception rule's alert opened here: read where its record opens (its own page is Home › Alerts).
  useEffect(() => {
    if (!openItem || openItem.kind !== 'RULE_ALERT' || alertRecords[openItem.key] !== undefined) return
    const key = openItem.key
    setAlertRecords((current) => ({ ...current, [key]: { status: 'loading' } }))
    fetchAlertRecord(api, openItem.record.id)
      .then((record) => setAlertRecords((current) => ({ ...current, [key]: { status: 'ready', data: `${prefix}${recordAddress(record, OFFICE_PAGES)}` } })))
      .catch((error: unknown) => setAlertRecords((current) => ({ ...current, [key]: { status: 'error', problem: readProblem(error) } })))
  }, [openItem, alertRecords, api, prefix])

  // ---- live ------------------------------------------------------------------------------------------------------------
  const events = useMemo(() => new Set([...(queue.status === 'ready' ? queue.data.answer.live.events : []), ...flowEvents, ...comingEvents]), [queue, flowEvents, comingEvents])
  const pendingRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readAgain = useCallback(() => {
    // Several events of one change arrive together: one read for them (half a second).
    if (pendingRead.current) clearTimeout(pendingRead.current)
    pendingRead.current = setTimeout(() => {
      pendingRead.current = null
      void refreshQueue()
      void loadFlow()
      void loadPanels()
      void loadComing()
      if (Date.now() - numbersReadAt.current > 60_000) void loadNumbers()
    }, 500)
  }, [refreshQueue, loadFlow, loadPanels, loadComing, loadNumbers])
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

  // ---- the alert verbs, Handled today, Arrange Today ---------------------------------------------------------------------
  const loadDialog = useCallback(
    async (request: DialogRequest) => {
      if (request.kind === 'assign') {
        setDialog({ kind: 'assign', key: request.key, people: { status: 'loading' } })
        try {
          const people = await fetchAssignees(api, request.key)
          setDialog((current) => (current?.kind === 'assign' && current.key === request.key ? { ...current, people: { status: 'ready', data: people } } : current))
        } catch (error) {
          setDialog((current) => (current?.kind === 'assign' && current.key === request.key ? { ...current, people: { status: 'error', problem: readProblem(error) } } : current))
        }
      } else if (request.kind === 'handled') {
        setDialog({ kind: 'handled', list: { status: 'loading' } })
        try {
          const list = handledView(await fetchHandled(api), prefix)
          setDialog((current) => (current?.kind === 'handled' ? { kind: 'handled', list: { status: 'ready', data: list } } : current))
        } catch (error) {
          setDialog((current) => (current?.kind === 'handled' ? { kind: 'handled', list: { status: 'error', problem: readProblem(error) } } : current))
        }
      } else setDialog(request)
    },
    [api, prefix],
  )

  /** One alert verb: the row as read, a notice, the list read again (a resolved row leaves; the next row opens). */
  const act = async (key: string, run: (item: TodayItem) => Promise<{ resolved: boolean }>, done: (item: TodayItem) => Notice): Promise<boolean> => {
    const item = items.find((entry) => entry.key === key)
    if (!item) return false
    const keys = items.map((entry) => entry.key)
    setBusy(true)
    setNotice(null)
    try {
      const answer = await run(item)
      setNotice(done(item))
      setDialog(null)
      if (answer.resolved && openRef.current === key) setParam('open', nextAfter(keys, key))
      await loadQueue()
      return true
    } catch (error) {
      const problem = actionProblem(error)
      setNotice({ key: problem.key, tone: problem.tone })
      setDialog(null)
      if (problem.reload) void loadQueue()
      return false
    } finally {
      setBusy(false)
    }
  }

  // ---- W2a: Done and Snooze of my own rows, Snooze of an alert ---------------------------------------------------------
  /** One own verb: a notice, the list read again (a done or snoozed row leaves; the next row opens); the bell re-reads. */
  const ownAct = async (key: string, run: (item: TodayItem) => Promise<unknown>, done: (item: TodayItem) => Notice): Promise<boolean> => {
    const item = items.find((entry) => entry.key === key)
    if (!item) return false
    const keys = items.map((entry) => entry.key)
    setBusy(true)
    setNotice(null)
    try {
      await run(item)
      setNotice(done(item))
      setDialog(null)
      if (openRef.current === key) setParam('open', nextAfter(keys, key))
      // The bell counts mentions: tell the shell (it reads its count again).
      if (item.kind === 'MENTION') window.dispatchEvent(new Event('factory:notifications-changed'))
      await loadQueue()
      void loadComing()
      return true
    } catch (error) {
      const problem = actionProblem(error)
      setNotice({ key: problem.key, tone: problem.tone })
      setDialog(null)
      if (problem.reload) void loadQueue()
      return false
    } finally {
      setBusy(false)
    }
  }
  const markDone = (key: string) =>
    ownAct(
      key,
      (item) => {
        const target = snoozeTarget(item)
        return target.kind === 'task' ? setTaskStatus(api, target.taskId, 'DONE') : target.kind === 'notification' ? setMentionDone(api, target.notificationId, true) : Promise.reject(new Error('not an own row'))
      },
      (item) => ({ key: item.kind === 'TASK_DUE' ? 'today.own.doneTask' : 'today.own.doneMention', tone: 'success', params: { record: item.record.label } }),
    )
  const snooze = (key: string, until: string | null) =>
    ownAct(
      key,
      (item) => {
        const target = snoozeTarget(item)
        if (target.kind === 'task') return until === null ? Promise.reject(new Error('a task snoozes until a time')) : snoozeTask(api, target.taskId, until)
        if (target.kind === 'notification') return snoozeMention(api, target.notificationId, until)
        return snoozeRow(api, item, until)
      },
      (item) => ({ key: until === null ? 'today.own.snoozedUntilChange' : 'today.own.snoozed', tone: 'success', params: { record: item.record.label } }),
    )

  // ---- the view model --------------------------------------------------------------------------------------------------
  const model: TodayViewModel = {
    access: allowed ? 'open' : 'refused',
    tileSet: W2A_TILES,
    comingUp: coming,
    numbers: { ...numbers, prefix },
    alertRecords,
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
              // The tiles the screen draws (the API may count a category it has no tile for: TASK).
              tiles: queue.data.answer.counts.tiles.filter((entry): entry is { tile: Tile; count: number; complete: boolean } => (W2A_TILES as readonly string[]).includes(entry.tile)),
              kindLabels: Object.fromEntries(queue.data.answer.counts.byKind.map((entry) => [entry.kind, entry.label])),
              items: queue.data.items.map((item) => queueItem(item, prefix)),
              more: queue.data.cursor !== null,
              loadingMore: queue.data.loadingMore,
              fresh: queue.data.pending ? Math.max(1, freshCount(queue.data.items, queue.data.pending.items)) : 0,
              handledToday: queue.data.answer.handled.today,
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
    layout: layout.layout,
    dialog,
    arrangeable: {
      panels: PANELS.filter((panel) => permissions.has(panel.permission)).map((panel) => ({ id: panel.id })),
      lenses: flow?.status === 'ready' ? flow.data.map((entry) => ({ lens: entry.lens, label: entry.label })) : [],
    },
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
          lensPicked.current = true
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
        onDialog: (request) => {
          // Closing a dialog keeps the notice its action just set (a snooze closes its own dialog after it).
          if (request === null) setDialog(null)
          else {
            setNotice(null)
            void loadDialog(request)
          }
        },
        onRetryDialog: () => {
          if (dialog?.kind === 'assign') void loadDialog({ kind: 'assign', key: dialog.key })
          else if (dialog?.kind === 'handled') void loadDialog({ kind: 'handled' })
        },
        onAcknowledge: (key) => act(key, (item) => acknowledgeRow(api, item), () => ({ key: 'today.actions.acknowledged', tone: 'success' })),
        onDone: markDone,
        onSnooze: snooze,
        onRetryNumbers: () => void loadNumbers(),
        onRetryComing: () => {
          setComing({ status: 'loading' })
          void loadComing()
        },
        onAssign: (key, assigneeId) => {
          const name = dialog?.kind === 'assign' && dialog.people.status === 'ready' ? (dialog.people.data.find((person) => person.id === assigneeId)?.name ?? '') : ''
          return act(key, (item) => assignRow(api, item, assigneeId), () => (assigneeId === null ? { key: 'today.actions.takenBack', tone: 'success' } : { key: 'today.actions.assigned', tone: 'success', params: { name } }))
        },
        onResolve: (key, note) => act(key, (item) => resolveRow(api, item, note), (item) => ({ key: 'today.actions.resolved', tone: 'success', params: { record: item.record.label } })),
        onArrange: async (next) => {
          setNotice(null)
          try {
            const answer = await saveLayout(api, next, layoutRef.current.version)
            setLayout({ layout: answer.layout, version: answer.version })
            if (answer.layout.mainLens) setLens(answer.layout.mainLens)
            setDialog(null)
            setPanels({})
            setNotice({ key: 'today.arrange.saved', tone: 'success' })
          } catch (error) {
            const problem = actionProblem(error)
            setDialog(null)
            setNotice({ key: problem.reload ? 'today.arrange.changed' : problem.key, tone: problem.tone })
            if (problem.reload) void loadLayout()
          }
        },
      }}
    />
  )
}
