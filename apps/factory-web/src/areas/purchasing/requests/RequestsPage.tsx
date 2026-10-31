'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { parseRequestId } from '@nexus/factory-domain/purchasing/requests/requests'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { listSites, type SiteOption } from '../../_shared/buying/api'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { csvOf, phrase, readProblem, todayIn, writeProblem } from '../../_shared/buying/model'
import { convertRequests, getRequest, listRequests, previewConversion, rejectPlanLines, requestCounts, type BuyRequest, type RequestCounts } from './api'
import {
  convertRefusal,
  convertRequestsOf,
  filtersOf,
  intoBody,
  openOf,
  rejectLinesOf,
  requestQuery,
  requestsAddress,
  requestsCan,
  viewOf,
  type DetailModel,
  type DraftModel,
  type Filters,
  type RejectModel,
  type RequestsModel,
  type RequestsView,
} from './model'
import { RequestsView as RequestsScreen } from './view/RequestsView'

/** The live events that may change the queue: a conversion, a plan run or decision, a PO, an approved source. */
const LIVE_PREFIXES = ['purchase_requests.', 'planning.', 'purchase_order.', 'supplier_item.'] as const

/**
 * `/w/<company>/purchasing/requests` (SCR-236): the queue of the saved view (`?view=`) with the site (`?site=`), the
 * kind (`?kind=`), the search (`?q=`) and the group (`?group=`, drawn on the client); the tiles (GET …/counts); the open
 * request (`?open=<request id>` → GET …/:kind/:refId); "Draft POs for n" (preview, then ONE convert with the dialog's own
 * Idempotency-Key); "Reject with reason" (planning's set-aside of the plan lines); live events behind "N updates · Show".
 */
export function RequestsPage() {
  return (
    <WithMessages namespaces={['purchasing-requests', 'lists']}>
      <RequestsContainer />
    </WithMessages>
  )
}

function RequestsContainer() {
  const t = useT('purchasing-requests')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const base = pathname.replace(/\/$/, '')
  const prefix = base.replace(/\/purchasing\/requests$/, '')
  const can = useMemo(() => requestsCan(session.permissions), [session.permissions])
  const view = viewOf(params)
  const filters = filtersOf(params)
  const filtersKey = `${filters.site ?? ''}|${filters.kind ?? ''}|${filters.q}`
  const open = openOf(params)
  const today = todayIn(DEFAULT_TIME_ZONE)

  const [rows, setRows] = useState<RequestsModel['rows']>({ items: null, more: false, matching: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<{ value: RequestCounts | null; problem: string | null }>({ value: null, problem: null })
  const [sites, setSites] = useState<SiteOption[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<RequestsModel['notice']>(null)
  const [detail, setDetail] = useState<DetailModel | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<DraftModel | null>(null)
  const [reject, setReject] = useState<RejectModel | null>(null)
  const [offline, setOffline] = useState(false)
  const readId = useRef(0)
  const draftKey = useRef(newIdempotencyKey())

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const go = useCallback((nextView: RequestsView, nextFilters: Filters, nextOpen: string | null) => router.replace(requestsAddress(base, nextView, nextFilters, nextOpen), { scroll: false }), [base, router])

  const loadCounts = useCallback(async () => {
    if (!can.view) return
    try {
      setCounts({ value: await requestCounts(api, { siteId: filters.site, kind: filters.kind }), problem: null })
    } catch (error) {
      setCounts({ value: null, problem: readProblem(error) })
    }
    // filtersKey holds the site and kind.
  }, [api, can.view, filtersKey])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listRequests(api, requestQuery(view, filters, today))
      if (id !== readId.current) return
      setRows({ items: page.requests, more: page.nextCursor !== null, matching: page.matching, problem: null })
      setCursor(page.nextCursor)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, matching: null, problem: readProblem(error) })
    }
    // filtersKey holds the filters the query reads.
  }, [api, can.view, view, filtersKey, today])

  useEffect(() => {
    setRows({ items: null, more: false, matching: null, problem: null })
    void load()
  }, [load])
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])
  useEffect(() => {
    if (!can.sites) return
    listSites(api, session.company?.id ?? null)
      .then(setSites)
      .catch(() => setSites([]))
  }, [api, can.sites, session.company?.id])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listRequests(api, { ...requestQuery(view, filters, today), cursor })
      setRows((current) => ({ ...current, items: [...(current.items ?? []), ...page.requests.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: phrase(readProblem(error)) })
    }
  }, [api, cursor, view, filtersKey, today])

  // Live: the queue changed somewhere → "N updates · Show" (rows never move under the cursor); the tiles follow at once.
  const recount = useCoalesced(() => void loadCounts(), 800)
  const live = useLive(
    (change) => {
      if (!LIVE_PREFIXES.some((prefixOf) => change.type.startsWith(prefixOf))) return
      setUpdates((count) => count + 1)
      recount()
    },
    () => {
      void load()
      void loadCounts()
    },
    can.view,
  )

  // The open request (`?open=`): read again whenever the address names another one.
  const readDetail = useCallback(
    async (requestId: string) => {
      const parsed = parseRequestId(requestId)
      if (!parsed) {
        setDetail({ requestId, detail: { status: 'not_found' }, supplierId: null })
        return
      }
      setDetail((current) => ({ requestId, detail: { status: 'loading' }, supplierId: current?.requestId === requestId ? current.supplierId : null }))
      try {
        const value = await getRequest(api, parsed.kind, parsed.refId)
        setDetail((current) => (current?.requestId === requestId ? { ...current, detail: { status: 'ready', value } } : current))
      } catch (error) {
        const status = isApiError(error) && error.kind === 'not_found' ? 'not_found' : isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : null
        setDetail((current) => (current?.requestId === requestId ? { ...current, detail: status ? { status } : { status: 'error', problem: readProblem(error) } } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (!open || !can.view) {
      setDetail(null)
      return
    }
    void readDetail(open)
  }, [open, can.view, readDetail])

  const rowsOf = useCallback(
    (ids: readonly string[]): BuyRequest[] => {
      const found = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const fromDetail = detail?.detail.status === 'ready' && ids.includes(detail.requestId) && !found.some((row) => row.id === detail.requestId) ? [detail.detail.value.request] : []
      return [...found, ...fromDetail]
    },
    [rows.items, detail],
  )

  // "Draft POs for n": the preview (nothing written), then ONE conversion with the dialog's own key.
  const preview = useCallback(
    async (requestIds: string[], suppliers: Record<string, string>) => {
      setDraft((current) => (current ? { ...current, requestIds, preview: { status: 'loading' }, problem: null } : current))
      try {
        const value = await previewConversion(api, { requests: convertRequestsOf(rowsOf(requestIds), suppliers) })
        setDraft((current) => (current ? { ...current, preview: { status: 'ready', value } } : current))
      } catch (error) {
        setDraft((current) => (current ? { ...current, preview: { status: 'error', problem: readProblem(error) }, problem: convertRefusal(error) } : current))
      }
    },
    [api, rowsOf],
  )
  const openDraft = useCallback(
    (requestIds: string[]) => {
      if (requestIds.length === 0) return
      const suppliers = Object.fromEntries(requestIds.filter((id) => chosen[id]).map((id) => [id, chosen[id]!]))
      draftKey.current = newIdempotencyKey()
      setDraft({ requestIds, suppliers, preview: { status: 'loading' }, into: {}, busy: false, problem: null, result: null })
      void preview(requestIds, suppliers)
    },
    [chosen, preview],
  )
  const confirmDraft = useCallback(async () => {
    const current = draft
    if (!current || current.busy || current.preview.status !== 'ready') return
    setDraft({ ...current, busy: true, problem: null })
    try {
      const result = await convertRequests(api, { requests: convertRequestsOf(rowsOf(current.requestIds), current.suppliers), into: intoBody(current.preview.value.cards, current.into) }, draftKey.current)
      setDraft((state) => (state ? { ...state, busy: false, result } : state))
      setNotice({ tone: 'success', words: phrase('notice.drafted', { lines: result.lines.length, count: result.orders.length }), orders: result.orders.map((order) => ({ id: order.id, number: order.number })) })
      void load()
      void loadCounts()
    } catch (error) {
      // Changed meanwhile or refused: read the preview again with what holds now (a new key: a new attempt).
      draftKey.current = newIdempotencyKey()
      setDraft((state) => (state ? { ...state, busy: false, problem: convertRefusal(error) } : state))
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) {
        void load()
        void preview(current.requestIds, current.suppliers)
      }
    }
  }, [api, draft, load, loadCounts, preview, rowsOf])

  // "Reject with reason": the plan lines set aside in planning (a reorder row has no row to reject).
  const confirmReject = useCallback(async () => {
    const current = reject
    if (!current || current.busy || !current.reason) return
    setReject({ ...current, busy: true, problem: null })
    try {
      const lines = rejectLinesOf(rowsOf(current.requestIds))
      await rejectPlanLines(api, lines, current.reason, current.note || null)
      setReject(null)
      setNotice({ tone: 'success', words: phrase('notice.rejected', { count: lines.length }) })
      void load()
      void loadCounts()
    } catch (error) {
      setReject((state) => (state ? { ...state, busy: false, problem: writeProblem(error, (paths) => (paths.some((path) => path.replace(/\./g, '/') === 'body/note') ? phrase('reject.noteNeeded') : null)) } : state))
    }
  }, [api, reject, rowsOf, load, loadCounts])

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['kind', 'site', 'material', 'colour', 'quantity', 'uom', 'need', 'orderBy', 'supplier', 'status', ...(can.cost ? ['value', 'currency'] : [])].map((column) => t(`csv.${column}`))
      const csvRows = picked.map((row) => [
        t(`kind.${row.kind}`),
        row.site.code,
        `${row.item.code} ${row.item.name}`,
        row.colour?.name ?? '',
        row.quantity,
        t(`uom.${row.uom}`),
        row.needDate,
        row.orderBy.date,
        row.supplier?.name ?? '',
        t(`status.${row.status}`),
        ...(can.cost ? [row.expectedAmount === null || row.expectedAmount === undefined ? '' : (row.expectedAmount / 100).toFixed(2), row.currency ?? ''] : []),
      ])
      downloadText(`requests-to-buy-${today}.csv`, csvOf(header, csvRows))
    },
    [rows.items, can.cost, t, today],
  )

  const model: RequestsModel = {
    prefix,
    can,
    view,
    filters,
    rows,
    counts,
    sites,
    asOf,
    live,
    offline,
    updates,
    notice,
    detail: detail ? { ...detail, supplierId: chosen[detail.requestId] ?? null } : null,
    draft,
    reject,
    timeZone: DEFAULT_TIME_ZONE,
  }

  return (
    <RequestsScreen
      model={model}
      actions={{
        onView: (next) => go(next, filters, null),
        onFilters: (next) => go(view, next, open),
        onMore: () => void more(),
        onRetry: () => void load(),
        onRetryCounts: () => void loadCounts(),
        onShowUpdates: () => {
          void load()
          void loadCounts()
        },
        onExport: exportRows,
        onOpen: (requestId) => go(view, filters, requestId),
        onDismissNotice: () => setNotice(null),
        detail: {
          onSupplier: (supplierId) =>
            setChosen((current) => {
              if (!detail) return current
              const next = { ...current }
              if (supplierId) next[detail.requestId] = supplierId
              else delete next[detail.requestId]
              return next
            }),
          onRetry: () => open && void readDetail(open),
          onDraft: () => detail && openDraft([detail.requestId]),
        },
        onDraft: openDraft,
        draft: {
          onInto: (key, into) => setDraft((current) => (current ? { ...current, into: { ...current.into, [key]: into } } : current)),
          onLeaveOutHeld: () => {
            if (!draft || draft.preview.status !== 'ready') return
            const heldIds = new Set(draft.preview.value.held.map((entry) => entry.requestId))
            const left = draft.requestIds.filter((id) => !heldIds.has(id))
            if (left.length === 0) {
              setDraft(null)
              return
            }
            void preview(left, draft.suppliers)
          },
          onRetry: () => draft && void preview(draft.requestIds, draft.suppliers),
          onConfirm: () => void confirmDraft(),
          onClose: () => {
            if (draft?.busy) return
            setDraft(null)
          },
        },
        onReject: (requestIds) => {
          const ids = rowsOf(requestIds)
            .filter((row) => row.kind === 'PLAN' && row.status === 'OPEN')
            .map((row) => row.id)
          if (ids.length > 0) setReject({ requestIds: ids, reason: '', note: '', busy: false, problem: null })
        },
        reject: {
          onReason: (reason) => setReject((current) => (current ? { ...current, reason } : current)),
          onNote: (note) => setReject((current) => (current ? { ...current, note } : current)),
          onConfirm: () => void confirmReject(),
          onClose: () => {
            if (reject?.busy) return
            setReject(null)
          },
        },
      }}
    />
  )
}
