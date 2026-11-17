'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { newIdempotencyKey } from '../../../lib/api/client'
import { WithMessages } from '../../../record-panels/i18n'
import {
  countWorkOrders,
  createWorkOrder,
  findOrders,
  getOpenLines,
  listWorkOrders,
  type OrderOption,
  type WorkOrderCounts,
  type WorkOrderRow,
} from '../_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem, writeProblem } from '../_shared/model'
import { daysLate } from '@nexus/factory-domain/production/work-orders/machine'
import type { ListMode } from '../../../list-frame/w2b/model'
// ---- F-PR-03: the list by risk (sort, computed filters, the customer filter `?party=`, grouped by customer; the export follows) ----
import type { WorkOrderCounts as Counts } from '../_shared/api'
import { useProductionCustomers } from '../_shared/customer/use-customers'
import { ListToolsContext, useListToolsTransport, type ListToolsTransport } from '../../../list-frame/tools/transport'
import { initiallyCollapsed, toggleGroup } from '../../../list-frame/groups/model'
import { customerGroupsOf, groupsToCount, listAddress, listQueryOf, termsOf, withScreenSort, type ListTerms } from './list/model'
// ---- end F-PR-03
import { linesOfStyle, NO_NEW_ORDER, openGridOf, pickedAfter, stylesOf, type BulkReleaseModel, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'
import { getReadiness, holdReasons, placeHold, type ReadinessRow } from './daily/api'
import { DAILY_NAMESPACE, dailyCan, dailyProblem, NO_DAILY, READINESS_STATUSES, type DailyModel } from './daily/model'
import { applyRowsOf } from '@nexus/factory-domain/views/bulk/rules'
import { applyRelease, previewRelease } from './every-shift/api'
import { SHIFT_NAMESPACE } from './every-shift/model'
// F-PR-21: Mine, the Supervisor column and "Assign supervisor…" (THE assign dialog, areas/_shared/production-supervisor).
import { assignHeld, SUPERVISOR_NS, targetsOfRows } from '../../_shared/production-supervisor/model'
import { useAssignSupervisor } from '../../_shared/production-supervisor/use-assign-supervisor'
// F-PR-22: "Note to N…" and a row's "Office note…" (THE note dialog, areas/production/_shared/notes).
import { NOTES_NS, openHeld, targetsOfRows as noteTargetsOfRows } from '../_shared/notes/model'
import { useNoteDialog } from '../_shared/notes/use-note-dialog'

/**
 * `/w/<company>/production/work-orders` (SCR-069): reads the work orders of the saved view (`?view=`, default open) and
 * the search (`?q=`, also the customer, its PO and the sales order: B-PR-34), 50 a page with "Show more" (cursor), the tiles' counts,
 * and keeps them live (workorder.* and
 * production.* events wait behind "N updates · Show": rows never move under the cursor). `?new=1` opens New work order.
 * `?new=1&order=<number>` opens it with that sales order chosen (the order studio's Make work orders).
 * Bulk: Export N (the selected rows through the shared export engine, B-W2b-13), Edit N (due date, priority and rush through
 * the review, then Undo) and Release N (B-W2b-59: the API's preview of the rows as they are now, with what holds each,
 * then each release through its own command). B-W2b-13: `?mode=board|calendar|cards` (the list frame's modes) and
 * `?due=<relative day>` (the quick filter; the API resolves the word with its today); the due date and priority edit in
 * the grid. B-W2b-59: `?rush=true` (the quick filter).
 * F-PR-03 (production plan §5, 06-tree A.3): sorted by risk (`?sort=risk|due|newest`, risk by default and written in every
 * address the page makes), the computed filters `?waitingOn=`, `?risk=`, `?blockedBy=`, the Production pages' customer filter
 * `?party=` (the rows and the tiles), grouped by customer (`?group=party`: the loaded rows under their customer, each header with
 * the server's figures for that customer), the readiness word read only while its column is shown, and the export given the
 * screen's sort when the address names none (the work orders file reads the same terms, B-PR-34).
 */
const MODES: readonly ListMode[] = ['table', 'board', 'calendar', 'cards']
/** Today in the site's zone (YYYY-MM-DD): the calendar's today and the days late after a save. */
const romeDay = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function WorkOrdersPage() {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, SHIFT_NAMESPACE, 'lists', /* F-PR-21 */ SUPERVISOR_NS, /* F-PR-22 */ NOTES_NS]}>
      <WorkOrdersContainer />
    </WithMessages>
  )
}

function WorkOrdersContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/work-orders\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  // F-PR-03: every term of the list from its address (one place: termsOf).
  const search = params?.toString() ?? ''
  const terms = useMemo(() => termsOf(params, MODES), [search])
  const { view, q, mode, due, rush } = terms
  const readKey = JSON.stringify(listQueryOf(terms))
  const customers = useProductionCustomers('work-orders')
  const newAsked = params?.get('new') === '1'
  // `?new=1&order=<number>` (the sales order studio's "Make work orders"): the dialog opens with that order chosen.
  const autoPick = useRef<string | null>(newAsked ? (params?.get('order')?.trim() || null) : null)
  const chooseRef = useRef<(order: OrderOption | null) => void>(() => undefined)

  const [rows, setRows] = useState<WorkOrdersListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<WorkOrdersListModel['notice']>(null)
  const [newOrder, setNewOrder] = useState<NewWorkOrderModel | null>(null)
  const [release, setRelease] = useState<BulkReleaseModel | null>(null)
  const releaseKey = useRef(newIdempotencyKey())
  const readId = useRef(0)
  // B-W2a-46: the readiness word per row (one read per page of rows) and Hold N.
  const dcan = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const [readiness, setReadiness] = useState<Record<string, ReadinessRow> | null>(null)
  const [daily, setDaily] = useState<DailyModel>(() => NO_DAILY(dcan))
  // F-PR-03: the read's clock (the waiting ages), each customer group's figures, the groups folded, the columns on screen.
  const [now, setNow] = useState(() => Date.now())
  const [groupCounts, setGroupCounts] = useState<Record<string, Counts | 'reading' | 'failed'>>({})
  const [collapsed, setCollapsed] = useState<string[] | null>(null)
  const [shown, setShown] = useState<readonly string[]>([])

  // F-PR-03: the list's address with some terms changed (the sort always written: the export reads it).
  const termsRef = useRef(terms)
  termsRef.current = terms
  const go = useCallback((next: Partial<ListTerms>, extra: { new?: boolean } = {}) => router.replace(listAddress(pathname, { ...termsRef.current, ...next }, extra)), [router, pathname])

  const load = useCallback(async () => {
    const id = ++readId.current
    const asked = termsRef.current
    setRows((current) => ({ ...current, problem: null, items: current.items }))
    setGroupCounts({})
    try {
      const page = await listWorkOrders(api, listQueryOf(asked))
      if (id !== readId.current) return
      setRows({ items: page.workOrders, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setNow(Date.now())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
    // F-PR-03: the tiles follow the customer filter (one customer's counts), as Floor now's do.
    countWorkOrders(api, undefined, asked.party ?? undefined)
      .then((answer) => id === readId.current && setCounts(answer))
      .catch(() => id === readId.current && setCounts(null))
  }, [api, readKey])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  // F-PR-03: the readiness word is read only while its column is shown (it is under Columns ▾ now: Blocked by says what holds a row).
  const readinessShown = shown.includes('readiness')
  const readinessIds = readinessShown ? (rows.items ?? []).filter((row) => READINESS_STATUSES.includes(row.status)).map((row) => row.id).slice(0, 100).join(',') : ''
  useEffect(() => {
    if (!readinessIds) return
    getReadiness(api, readinessIds.split(','))
      .then((answer) => setReadiness(Object.fromEntries(answer.map((row) => [row.workOrderId, row]))))
      .catch(() => setReadiness(null))
  }, [api, readinessIds])

  useEffect(() => {
    if (daily.dialog?.kind !== 'hold' || daily.reasons) return
    holdReasons(api)
      .then((reasons) => setDaily((current) => ({ ...current, reasons })))
      .catch(() => setDaily((current) => ({ ...current, problem: { key: 'problem.read' } })))
  }, [api, daily.dialog, daily.reasons])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listWorkOrders(api, listQueryOf(termsRef.current, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.workOrders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, readKey])

  // Live: a work order changed somewhere → "N updates · Show" (the tiles follow at once: they never move the cursor).
  const recount = useCoalesced(() => {
    countWorkOrders(api, undefined, termsRef.current.party ?? undefined)
      .then(setCounts)
      .catch(() => undefined)
  }, 800)

  // ---- F-PR-03: grouped by customer — the groups of the loaded rows, each customer's figures read once per read of the list ----
  const grouped = terms.group === 'party'
  const groups = useMemo(() => (grouped && rows.items ? customerGroupsOf(rows.items, customers.state.names) : []), [grouped, rows.items, customers.state.names])
  useEffect(() => {
    for (const partyId of groupsToCount(groups, groupCounts)) {
      setGroupCounts((current) => ({ ...current, [partyId]: 'reading' }))
      countWorkOrders(api, undefined, partyId)
        .then((answer) => setGroupCounts((current) => (partyId in current ? { ...current, [partyId]: answer } : current)))
        .catch(() => setGroupCounts((current) => (partyId in current ? { ...current, [partyId]: 'failed' } : current)))
    }
  }, [api, groups, groupCounts])
  const groupKeys = groups.map((group) => group.key).join(',')
  useEffect(() => {
    if (!grouped) setCollapsed(null)
    else if (collapsed === null && groupKeys) setCollapsed(initiallyCollapsed(groupKeys.split(',')))
  }, [grouped, groupKeys, collapsed])

  // F-PR-03: the export is told the screen's sort when the address names none (the file's own default is newest first).
  const outerTools = useListToolsTransport()
  const tools = useMemo<ListToolsTransport | null>(() => (outerTools ? { ...outerTools, startExport: (ask, key) => outerTools.startExport({ ...ask, query: withScreenSort(ask.query) }, key) } : null), [outerTools])
  // ---- end F-PR-03
  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      if (change.type.startsWith('workorder.')) setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  // ?new=1 (Today's New ▾, the band's button): the dialog, once.
  useEffect(() => {
    if (newAsked && !newOrder && can.manage) setNewOrder({ ...NO_NEW_ORDER })
  }, [newAsked, newOrder, can.manage])

  // The dialog's order search.
  const searchOrders = useCallback(
    async (query: string) => {
      setNewOrder((current) => (current ? { ...current, query, orders: null, ordersProblem: null } : current))
      try {
        const orders = await findOrders(api, query)
        setNewOrder((current) => (current && current.query === query ? { ...current, orders } : current))
        const asked = autoPick.current
        if (asked && query === asked) {
          autoPick.current = null
          const match = orders.find((order) => order.number === asked)
          if (match) chooseRef.current(match)
        }
      } catch (error) {
        setNewOrder((current) => (current && current.query === query ? { ...current, orders: null, ordersProblem: readProblem(error) } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (newOrder && newOrder.orders === null && newOrder.ordersProblem === null && newOrder.query === '' && can.orders) void searchOrders(autoPick.current ?? '')
    // Only when the dialog opens.
  }, [newOrder !== null])

  const chooseOrder = useCallback(
    async (order: OrderOption | null) => {
      setNewOrder((current) => (current ? { ...current, chosen: order, lines: null, linesProblem: null, styleId: null, picked: [], grid: {}, problem: null } : current))
      if (!order) return
      try {
        const lines = await getOpenLines(api, order.id)
        setNewOrder((current) => {
          if (!current || current.chosen?.id !== order.id) return current
          const styles = stylesOf(lines).filter((style) => style.open > 0)
          const styleId = styles[0]?.id ?? null
          const own = linesOfStyle(lines, styleId).filter((line) => !line.madeToMeasure && line.sizes.some((size) => size.open > 0))
          return { ...current, lines, styleId, picked: own.map((line) => line.id), grid: Object.fromEntries(own.map((line) => [line.id, openGridOf(line)])) }
        })
      } catch (error) {
        setNewOrder((current) => (current && current.chosen?.id === order.id ? { ...current, linesProblem: readProblem(error) } : current))
      }
    },
    [api],
  )

  chooseRef.current = (order) => void chooseOrder(order)

  const create = useCallback(async () => {
    const current = newOrder
    if (!current || current.busy) return
    setNewOrder({ ...current, busy: true, problem: null })
    try {
      const lines = current.picked.map((lineId) => ({
        salesOrderLineId: lineId,
        sizes: Object.entries(current.grid[lineId] ?? {})
          .filter(([, quantity]) => quantity > 0)
          .map(([size, quantity]) => ({ size, quantity })),
      }))
      const created = await createWorkOrder(api, { ...(current.dueDate ? { dueDate: current.dueDate } : {}), lines: lines.filter((line) => line.sizes.length > 0) })
      setNewOrder(null)
      router.push(`${prefix}/production/work-orders/${created.id}`)
    } catch (error) {
      setNewOrder((state) => (state ? { ...state, busy: false, problem: writeProblem(error) } : state))
    }
  }, [api, newOrder, prefix, router])

  // B-W2b-13: a cell or Edit N saved — the row takes its new due date, priority and version (days late follow the due date).
  const saved = useCallback((rowId: string, after: Readonly<Record<string, string | number | null>>, version: number) => {
    setRows((current) => ({
      ...current,
      items:
        current.items?.map((row) => {
          if (row.id !== rowId) return row
          const dueDate = 'due' in after ? ((after.due as string | null) ?? null) : row.dueDate
          const priority = typeof after.priority === 'number' ? after.priority : row.priority
          const rushed = typeof after.rush === 'string' ? after.rush === 'RUSH' : row.rush
          return { ...row, dueDate, priority, rush: rushed, version, daysLate: daysLate(row.status, dueDate, romeDay()) }
        }) ?? null,
    }))
  }, [])

  // B-W2b-59 (MES-017): Release N — the preview reads each row as it is now, Save releases each through its own command.
  const readRelease = useCallback(
    (ids: readonly string[]) => {
      setRelease((state) => (state ? { ...state, preview: null, state: { phase: 'reading' } } : state))
      previewRelease(api, ids)
        .then((preview) => setRelease((state) => (state ? { ...state, preview, state: { phase: 'ready' } } : state)))
        .catch((error: unknown) => setRelease((state) => (state ? { ...state, state: { phase: 'failed', words: { key: readProblem(error) } } } : state)))
    },
    [api],
  )
  const runRelease = useCallback(() => {
    if (!release?.preview || release.state.phase !== 'ready') return
    setRelease({ ...release, state: { phase: 'saving' } })
    applyRelease(api, applyRowsOf(release.preview), releaseKey.current)
      .then((results) => {
        setRelease((state) => (state ? { ...state, state: { phase: 'done', results } } : state))
        void load()
      })
      .catch((error: unknown) => setRelease((state) => (state ? { ...state, state: { phase: 'failed', words: writeProblem(error) } } : state)))
  }, [api, release, load])

  // ---- F-PR-21: THE assign dialog over the selection's orders; a Send reads the rows again (their marks, Mine). ----
  const assign = useAssignSupervisor(api, () => void load())
  const supervisorCan = { manage: session.permissions.includes('production.brand.manage') }
  // ---- end F-PR-21
  // ---- F-PR-22: THE note dialog over the picked work orders (or their sales orders); threads.post, else held in words. ----
  const noteCan = session.permissions.includes('threads.post')
  const note = useNoteDialog(api, { can: noteCan })
  // ---- end F-PR-22

  const model: WorkOrdersListModel = {
    prefix,
    can,
    view,
    q,
    mode,
    due,
    rush,
    today: romeDay(),
    rows,
    counts,
    asOf,
    live,
    updates,
    notice,
    newOrder,
    release,
    readiness: readinessShown ? readiness : null,
    daily: { ...daily, can: dcan },
    // F-PR-03
    sort: terms.sort,
    waitingOn: terms.waitingOn,
    risk: terms.risk,
    blockedBy: terms.blockedBy,
    customers: customers.state,
    group: terms.group,
    groupCounts,
    collapsed: collapsed ?? [],
    now,
    // F-PR-21
    supervisor: terms.supervisor,
    supervisorCan,
    assign: assign.model,
    // F-PR-18
    customerUrgency: terms.customerUrgency,
    // F-PR-22
    noteCan,
    note: note.model,
  }

  return (
    <ListToolsContext.Provider value={tools}>
    <WorkOrdersListView
      model={model}
      actions={{
        onView: (next) => go({ view: next }),
        onSearch: (next) => go({ q: next }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/production/work-orders/${id}`),
        onMode: (next) => go({ mode: next }),
        onDue: (next) => go({ due: next }),
        onRush: (next) => go({ rush: next }),
        // F-PR-03: the sort, the computed filters and the grouping (address terms); the customer filter (`?party=`); the groups.
        onTerms: (next) => go(next),
        onParty: (next) => go({ party: next }),
        onToggleGroup: (key) => setCollapsed((current) => toggleGroup(current ?? [], key)),
        onRetryGroup: (partyId) =>
          setGroupCounts((current) => {
            const rest = { ...current }
            delete rest[partyId]
            return rest
          }),
        onShownColumns: setShown,
        // F-PR-21: the selection's orders (each once; a work order of no one customer left out, counted), at most 100.
        onAssignSupervisor: (ids) => {
          const picked = (rows.items ?? []).filter((row: WorkOrderRow) => ids.includes(row.id))
          const targets = targetsOfRows(picked, session.permissions.includes('parties.view'))
          if (assignHeld(supervisorCan, targets)) return
          assign.open(targets.targets, { leftOut: targets.leftOut })
        },
        supervisor: assign.actions,
        // F-PR-22: the picked work orders (and their sales orders), at most 100; a customer named only as the reader may see it.
        onNote: (ids, from) => {
          const picked = (rows.items ?? []).filter((row: WorkOrderRow) => ids.includes(row.id))
          if (openHeld(noteCan, picked.length)) return
          note.open(noteTargetsOfRows(picked, session.permissions.includes('parties.view')), from)
        },
        note: note.actions,
        onSaved: saved,
        onReleaseMany: (ids) => {
          const picked = (rows.items ?? []).filter((row: WorkOrderRow) => ids.includes(row.id))
          releaseKey.current = newIdempotencyKey()
          setRelease({ rows: picked.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode })), preview: null, state: { phase: 'reading' } })
          readRelease(ids)
        },
        onRunRelease: runRelease,
        onRetryRelease: () => release && readRelease(release.rows.map((row) => row.id)),
        onCloseRelease: () => setRelease(null),
        onDismissNotice: () => setNotice(null),
        daily: {
          onDialog: (next) => setDaily((current) => ({ ...current, dialog: next, problem: null })),
          onPlaceHold: (input) => {
            if (daily.busy) return
            setDaily((current) => ({ ...current, busy: true, problem: null }))
            placeHold(api, input)
              .then((answer) => {
                setDaily((current) => ({ ...current, busy: false, dialog: null }))
                setNotice({ tone: 'success', words: { key: `${DAILY_NAMESPACE}:notice.heldMany`, params: { count: answer.workOrdersHeld.length } } })
                void load()
              })
              .catch((error: unknown) => setDaily((current) => ({ ...current, busy: false, problem: dailyProblem(error) })))
          },
        },
        onNew: (open) => {
          if (open) setNewOrder({ ...NO_NEW_ORDER })
          else {
            setNewOrder(null)
            if (newAsked) go({})
          }
        },
        newOrder: {
          onQuery: (query) => void searchOrders(query),
          onChoose: (order) => void chooseOrder(order),
          onStyle: (styleId) =>
            setNewOrder((current) => {
              if (!current) return current
              const own = linesOfStyle(current.lines, styleId).filter((line) => !line.madeToMeasure && line.sizes.some((size) => size.open > 0))
              return { ...current, styleId, picked: own.map((line) => line.id), grid: Object.fromEntries(own.map((line) => [line.id, openGridOf(line)])) }
            }),
          onPick: (lineId, on) =>
            setNewOrder((current) => {
              if (!current) return current
              const line = current.lines?.lines.find((entry) => entry.id === lineId)
              const picked = pickedAfter(current.lines?.lines ?? [], current.picked, lineId, on) // B-W2b-368: a unit alone
              const grid = { ...current.grid }
              if (on && line && !grid[lineId]) grid[lineId] = openGridOf(line)
              return { ...current, picked, grid }
            }),
          onGrid: (grid) => setNewOrder((current) => (current ? { ...current, grid } : current)),
          onDueDate: (dueDate) => setNewOrder((current) => (current ? { ...current, dueDate } : current)),
          onCreate: () => void create(),
        },
      }}
    />
    </ListToolsContext.Provider>
  )
}
