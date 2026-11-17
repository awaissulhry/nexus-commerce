'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
// B-TH-230: the New messages column — one read of the page's rows.
import { readUnreadWith } from '../../../lib/last-message-cell/api'
import { useUnread } from '../../../lib/last-message-cell/use-unread'
import {
  assignMany,
  companiesWithoutNumbering,
  declineMany,
  listAssignees,
  listCustomers,
  mailToSortCount,
  readPicture,
  // B-TH-233: Incoming's one read, paged; the Customer replies view.
  INCOMING_PAGE,
  listCustomerReplies,
  listIncoming,
  type IncomingList,
  type IncomingRow,
  type PartyOption,
  type WaitingPage,
} from './api'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useCatalogueOrder } from './use-catalogue-order'
import {
  addressOf,
  addressText,
  DISMISSED_STORE,
  emptyDecline,
  HOME_ADDRESS,
  inquiriesCan,
  nextAfter,
  queryOf,
  readProblem,
  fullPageHref,
  writeProblem,
  // B-TH-233
  approvalsHref,
  CUSTOMER_REPLIES,
  mergePages,
  rowHref,
  navIdsOf,
  placeOf,
  THREAD_TYPE,
  type ListAddress,
  type Notice,
  type NoticeFacts,
  type RowVerb,
} from './model'
import type { RecordVerb } from './record-model'
import { useInquiry } from './use-inquiry'
// B-TH-228: which receipts stay on the page when the queue moves on.
import { receiptStays } from './model'
import { useNewRequest } from './use-new-request'
import type { PictureLoader } from './view/cells'
import { InquiriesView, type BulkDialog } from './view/InquiriesView'

const readDismissed = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED_STORE) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-50) : []
  } catch {
    return []
  }
}
const keepDismissed = (keys: string[]) => {
  try {
    window.localStorage.setItem(DISMISSED_STORE, JSON.stringify(keys.slice(-50)))
  } catch {
    // A private window or blocked storage: the notice comes back next time.
  }
}

/**
 * `/w/<company>/sales/incoming` (SCR-105; B-TH-216: Sales › Incoming, renamed from Inquiries): the requests in the shared list frame with the API's own filters in the address
 * — `?tile=` (a saved filter; the tiles), `?source=`, `?party=` / `?prospect=1`, `?q=` — the inquiry in its DetailModal
 * (`?open=<id>&tab=`, the record container `use-inquiry.tsx`; J / K walk the rows; after a decision the next one opens), New
 * request (`c`, `?new=1`; B-TH-221: the portal's compose with the customer or the prospect, `use-new-request.ts`), "Make
 * incoming request" from a mail (`?mail=<inbound mail id>`, the same window), Assign to… and Decline N over a selection (the
 * API's all-or-none bulk routes). Live `inquiry.*` changes wait behind "N updates · Show".
 * B-TH-233: the rows come from Incoming's one read (GET /sales/incoming: requests, catalogue orders, change requests), page by page
 * ("Show more" by its cursor); `?kind=` narrows to one kind; `?catalogue=<id>` opens a catalogue order beside the list
 * (use-catalogue-order.tsx); `?tile=CUSTOMER_REPLIES` lists the conversations waiting on us (GET /threads/waiting?side=CUSTOMER).
 */
export function InquiriesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const addressRef = useRef(address)
  addressRef.current = address
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...addressRef.current, ...next })}`, { scroll: false }), [router, pathname])

  // ---- the list (B-TH-233: Incoming's one read over every door, page by page; "Customer replies" its own read) -------------------
  const [pages, setPages] = useState<IncomingList[] | null>(null)
  const [replies, setReplies] = useState<WaitingPage[] | null>(null)
  const [more, setMore] = useState<{ busy: boolean; problem: string | null }>({ busy: false, problem: null })
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [customers, setCustomers] = useState<PartyOption[] | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => setDismissed(readDismissed()), [])
  const readId = useRef(0)
  const query = useMemo(() => queryOf(address), [address])
  const queryKey = JSON.stringify(query)

  const repliesView = address.tile === CUSTOMER_REPLIES
  const repliesKey = JSON.stringify({ companyId: address.company, partyId: address.prospect ? null : address.party })
  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    setMore({ busy: false, problem: null })
    try {
      // "Customer replies" lists conversations (B-TH-047): Incoming's read then brings only the tiles' counts (one row).
      const [answer, waiting] = await Promise.all([
        listIncoming(api, JSON.parse(queryKey) as ReturnType<typeof queryOf>, repliesView ? { limit: 1 } : {}),
        repliesView && can.thread ? listCustomerReplies(api, JSON.parse(repliesKey) as { companyId: string | null; partyId: string | null }) : Promise.resolve(null),
      ])
      if (id !== readId.current) return
      setPages([answer])
      setReplies(waiting ? [waiting] : null)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, can.thread, queryKey, repliesView, repliesKey])

  useEffect(() => {
    setPages(null)
    setReplies(null)
    void load()
  }, [load])

  // The rows read so far (each row once) with the first page's counts; "Show more" reads the next page by the last page's cursor.
  const list = useMemo<IncomingList | null>(() => (pages && pages.length > 0 ? { ...pages[0]!, rows: repliesView ? [] : mergePages(pages), next: pages[pages.length - 1]!.next } : null), [pages, repliesView])
  const waiting = useMemo<WaitingPage | null>(() => (replies && replies.length > 0 ? { ...replies[0]!, rows: replies.flatMap((page) => page.rows), next: replies[replies.length - 1]!.next } : null), [replies])
  const readMore = useCallback(async () => {
    if (more.busy) return
    const id = readId.current
    const cursor = repliesView ? waiting?.next : list?.next
    if (!cursor) return
    setMore({ busy: true, problem: null })
    try {
      if (repliesView) {
        const page = await listCustomerReplies(api, JSON.parse(repliesKey) as { companyId: string | null; partyId: string | null }, { cursor })
        if (id === readId.current) setReplies((now) => (now ? [...now, page] : [page]))
      } else {
        const page = await listIncoming(api, JSON.parse(queryKey) as ReturnType<typeof queryOf>, { cursor })
        if (id === readId.current) setPages((now) => (now ? [...now, page] : [page]))
      }
      if (id === readId.current) setMore({ busy: false, problem: null })
    } catch (error) {
      if (id === readId.current) setMore({ busy: false, problem: readProblem(error) })
    }
  }, [api, more.busy, repliesView, waiting?.next, list?.next, repliesKey, queryKey])

  useEffect(() => {
    if (!can.view || !can.parties) return
    const controller = new AbortController()
    listCustomers(api, companyId, controller.signal)
      .then(setCustomers)
      .catch(() => setCustomers(null))
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId])

  // ---- B-TH-216: the one notice's facts (each read only for who may act on it), the Picture cell, a row opens its request ----
  const companies = useMemo(() => session.companies.map((entry) => ({ id: entry.id, name: entry.name, code: entry.code })), [session.companies]) // B-TH-233: + code (list-F12)
  const [noticeFacts, setNoticeFacts] = useState<NoticeFacts>({})
  const mayNumbering = session.permissions.includes('numbering.view')
  const maySort = session.permissions.includes('email.triage')
  useEffect(() => {
    if (!can.view) return
    const controller = new AbortController()
    if (mayNumbering && companies.length > 0)
      companiesWithoutNumbering(api, companies.map((entry) => entry.id), controller.signal)
        .then((ids) => setNoticeFacts((now) => ({ ...now, numberingMissing: ids.map((id) => companies.find((entry) => entry.id === id)?.name ?? id) })))
        .catch(() => undefined)
    if (maySort)
      mailToSortCount(api, controller.signal)
        .then((mailToSort) => setNoticeFacts((now) => ({ ...now, mailToSort })))
        .catch(() => undefined)
    return () => controller.abort()
  }, [api, can.view, mayNumbering, maySort, companies])
  const loadPicture = useCallback<PictureLoader>(async (inquiryId) => {
    const picture = await readPicture(api, inquiryId)
    return picture.small ? { url: picture.small.url, expiresAt: picture.small.expiresAt } : null
  }, [api])
  // ---- end B-TH-216 ----

  const live = useLiveBus(
    {
      onChange: (change) => {
        // B-TH-233: every kind of row changes live — a request, a catalogue order, a change request (the rows wait behind "N updates").
        if (change.type.startsWith('inquiry.') || change.type.startsWith('portal_order_request.') || change.type.startsWith('order_change_request.')) setUpdates((count) => count + 1)
        // Customer replies: a message moves a conversation in or out of the view.
        else if (repliesView && change.type.startsWith('thread.')) setUpdates((count) => count + 1)
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- B-TH-230: the reader's own new messages per request on the page (threads.read; ONE POST /threads/unread of ≤ 200 rows), read
  // again on a live message and when the pane moves on (the request just read in the pane counts 0 then).
  const readsThreads = can.thread
  const [unreadTick, setUnreadTick] = useState(0)
  useLiveBus({ onChange: (change) => change.type.startsWith('thread.') && setUnreadTick((tick) => tick + 1), onReconnect: () => setUnreadTick((tick) => tick + 1) }, readsThreads)
  useEffect(() => setUnreadTick((tick) => tick + 1), [address.open, address.catalogue])
  // B-TH-233: each kind's own thread (a request, a catalogue order, a change request).
  const unreadRows = useMemo(() => (list ? list.rows.map((row) => ({ recordType: THREAD_TYPE[row.kind], id: row.id })) : []), [list])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  // ---- end B-TH-230

  // ---- the inquiry in its DetailModal ------------------------------------------------------------------------------------------
  const [pendingVerb, setPendingVerb] = useState<RecordVerb | null>(null)
  // B-TH-233: J / K and "after a decision, the next" walk the rows that open beside the list (requests and catalogue orders).
  const ids = useMemo(() => navIdsOf(list), [list])
  const idsRef = useRef(ids)
  idsRef.current = ids
  const rowsRef = useRef<readonly IncomingRow[]>([])
  rowsRef.current = list?.rows ?? []
  const openId = useCallback((id: string | null) => {
    const row = id ? rowsRef.current.find((one) => one.id === id) : undefined
    if (!id || !row) return go({ open: null, catalogue: null, tab: 'request' })
    const place = placeOf(row)
    if (place === 'catalogue') go({ open: null, catalogue: id, tab: 'request' })
    else if (place === 'request') go({ open: id, catalogue: null, tab: id === addressRef.current.open ? addressRef.current.tab : 'request' })
  }, [go])
  const record = useInquiry({
    inquiryId: address.open,
    tab: address.tab,
    onTab: (tab) => go({ tab }),
    onChanged: () => void load(),
    onDecided: (inquiryId) => {
      const next = nextAfter(idsRef.current, inquiryId)
      if (next && next !== inquiryId) openId(next)
    },
    pendingVerb,
    onPendingDone: () => setPendingVerb(null),
  })
  // B-TH-233 (B-TH-040, pane-actions-F13): a catalogue order beside the list — its facts, its thread, Accept as order / quote, Refuse.
  const catalogueRow = address.catalogue ? (list?.rows.find((row) => row.id === address.catalogue) ?? null) : null
  const catalogue = useCatalogueOrder({
    requestId: address.catalogue,
    companyId: catalogueRow?.companyId ?? companyId,
    onChanged: () => void load(),
    onDecided: (requestId) => {
      const next = nextAfter(idsRef.current, requestId)
      if (next && next !== requestId) openId(next)
    },
  })
  const catalogueNotice = catalogue.model.notice
  useEffect(() => {
    // The decision's receipt stays on the page when the queue moves on.
    if (catalogueNotice && catalogueNotice.key.startsWith('catalogue.done.')) setNotice(catalogueNotice)
  }, [catalogueNotice])
  const detailNotice = record.model.notice
  useEffect(() => {
    // A decision's receipt stays on the page when the queue moves on to the next inquiry.
    // B-TH-228: Make order's receipt (confirmed, or waiting for approval and why) stays too (model receiptStays).
    if (detailNotice && receiptStays(detailNotice.key)) setNotice(detailNotice)
  }, [detailNotice])

  const onRowVerb = useCallback(
    (row: IncomingRow, verb: RowVerb) => {
      if (row.kind !== 'REQUEST') return
      setPendingVerb(verb)
      go({ open: row.id, catalogue: null, tab: verb === 'quote' ? 'quote' : 'request' })
    },
    [go],
  )

  // ---- B-TH-221: New request (typed: a call, a visit, a fair, a letter), and "Make incoming request" from a mail -------------------
  const [unnumbered, setUnnumbered] = useState(false)
  const newOpen = address.isNew || !!address.mail
  useEffect(() => {
    if (!newOpen || !companyId || !mayNumbering) return
    const controller = new AbortController()
    companiesWithoutNumbering(api, [companyId], controller.signal)
      .then((ids) => setUnnumbered(ids.includes(companyId)))
      .catch(() => setUnnumbered(false))
    return () => controller.abort()
  }, [newOpen, companyId, mayNumbering, api])
  const newRequest = useNewRequest({
    open: newOpen,
    mailId: address.mail,
    api,
    companyId,
    can,
    me,
    offline,
    unnumbered,
    onDone: (inquiry, failed) => {
      setNotice({ key: failed > 0 ? 'new.doneFiles' : 'new.done', params: { number: inquiry.number, count: failed }, tone: failed > 0 ? 'warning' : 'success' })
      go({ isNew: false, mail: null, open: inquiry.id, tab: failed > 0 ? 'files' : 'request' })
      void load()
    },
    onClose: () => go({ isNew: false, mail: null }),
  })
  // ---- end B-TH-221 ----

  // ---- Assign to… and Decline N over a selection -----------------------------------------------------------------------------
  const [bulk, setBulk] = useState<BulkDialog | null>(null)
  const bulkKey = useRef<string | null>(null)
  const subjectOf = (count: number) => ({ key: 'bulk.subject', params: { count } })
  const readBulkPeople = useCallback(
    (inquiryIds: readonly string[]) => {
      if (!companyId) return
      setBulk({ kind: 'assign', ids: inquiryIds, model: { subject: subjectOf(inquiryIds.length), current: null, people: { status: 'loading' }, busy: false, notice: null, offline: false } })
      listAssignees(api, companyId, null)
        .then((value) => setBulk((now) => (now?.kind === 'assign' ? { ...now, model: { ...now.model, people: { status: 'ready', value } } } : now)))
        .catch((error: unknown) => setBulk((now) => (now?.kind === 'assign' ? { ...now, model: { ...now.model, people: { status: 'error', problem: readProblem(error) } } } : now)))
    },
    [api, companyId],
  )
  // B-TH-233: only requests are assigned or declined in bulk (the selection's other kinds are left out and said, model bulkReach).
  const itemsOf = (inquiryIds: readonly string[]) => (list?.rows ?? []).flatMap((row) => (row.kind === 'REQUEST' && row.request && inquiryIds.includes(row.id) ? [{ inquiryId: row.id, version: row.request.version }] : []))
  const bulkFailed = (error: unknown) => {
    bulkKey.current = null
    const problem = writeProblem(error)
    setBulk((now) => (now ? ({ ...now, model: { ...now.model, busy: false, notice: { key: problem.key, params: problem.params, tone: 'danger' } } } as BulkDialog) : now))
    if (problem.stale) void load()
  }
  const bulkAssign = async (assigneeId: string | null) => {
    if (bulk?.kind !== 'assign' || bulk.model.busy) return
    setBulk({ ...bulk, model: { ...bulk.model, busy: true, notice: null } })
    bulkKey.current ??= newIdempotencyKey()
    try {
      const answer = await assignMany(api, itemsOf(bulk.ids), assigneeId, bulkKey.current)
      bulkKey.current = null
      const person = bulk.model.people.status === 'ready' ? bulk.model.people.value.people.find((one) => one.id === assigneeId) : undefined
      setBulk(null)
      setNotice({ key: assigneeId === null ? 'bulk.unassigned' : person?.me ? 'bulk.assignedMe' : 'bulk.assigned', params: { count: answer.inquiries.length, name: person?.name ?? '' }, tone: 'success' })
      void load()
    } catch (error) {
      bulkFailed(error)
    }
  }
  const bulkDecline = async () => {
    if (bulk?.kind !== 'decline' || bulk.model.busy || !bulk.model.draft.reason) return
    setBulk({ ...bulk, model: { ...bulk.model, busy: true, notice: null } })
    bulkKey.current ??= newIdempotencyKey()
    try {
      const note = bulk.model.draft.note.trim()
      const answer = await declineMany(api, itemsOf(bulk.ids), { reason: bulk.model.draft.reason, ...(note ? { note } : {}) }, bulkKey.current)
      bulkKey.current = null
      setBulk(null)
      setNotice({ key: 'bulk.declined', params: { count: answer.inquiries.length, reason: `decline.${bulk.model.draft.reason}` }, tone: 'success' })
      void load()
    } catch (error) {
      bulkFailed(error)
    }
  }

  return (
    <InquiriesView
      model={{
        prefix,
        me,
        companyId,
        can,
        address,
        list,
        problem,
        customers,
        asOf,
        live,
        updates,
        notice,
        dismissed,
        newRequest: newRequest.model, // B-TH-221
        bulk: bulk ? ({ ...bulk, model: { ...bulk.model, offline } } as BulkDialog) : null,
        detail: address.open ? record.model : null,
        // B-TH-217: the pane's facts — handled meanwhile, "Close thread…", the menu's rights.
        pane: address.open ? { handled: record.handled, closing: record.closing, rights: { erase: session.permissions.includes('privacy.requests.manage'), closeThread: session.permissions.includes('threads.manage') } } : null,
        companies, // B-TH-216
        noticeFacts, // B-TH-216
        unread: readsThreads ? unread : null, // B-TH-230
        // ---- B-TH-233: the pages read (Show more), Customer replies, the catalogue order beside the list
        more: { next: repliesView ? !!waiting?.next : !!list?.next, busy: more.busy, problem: more.problem, page: INCOMING_PAGE },
        replies: repliesView ? (can.thread ? waiting : null) : undefined,
        built: OFFICE_PAGES,
        catalogue: address.catalogue ? catalogue.model : null,
        // ---- end B-TH-233
      }}
      slots={{ thread: record.thread, catalogueThread: catalogue.thread }}
      actions={{
        onAddress: (patch) => go({ ...patch, open: patch.open ?? null, catalogue: patch.catalogue ?? null }),
        onClearFilters: () => go({ ...HOME_ADDRESS }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        // B-TH-233: a row opens by its kind — a request or a catalogue order beside the list, a change request in Home › Approvals.
        onOpen: openId,
        // B-TH-216 (grid-F29 as on the Orders sheet): the rest of a row opens it; ⌘ / Ctrl a request's full page (any other's own place) in a new tab.
        onOpenRow: (row, newTab) => {
          const place = placeOf(row)
          if (place === 'approvals') return newTab ? void window.open(approvalsHref(prefix), '_blank', 'noopener') : router.push(approvalsHref(prefix))
          if (!newTab) return openId(row.id)
          window.open(place === 'request' ? fullPageHref(prefix, row.id, addressRef.current) : rowHref(prefix, addressRef.current, row), '_blank', 'noopener')
        },
        onMore: () => void readMore(),
        onGo: (href, newTab) => (newTab ? void window.open(href, '_blank', 'noopener') : router.push(href)),
        loadPicture,
        // B-TH-217: the pane's own acts.
        pane: {
          onNext: () => {
            const current = addressRef.current.open ?? addressRef.current.catalogue ?? ''
            const next = nextAfter(idsRef.current, current)
            openId(next && next !== current ? next : null)
          },
          onErase: () => window.open(`${prefix}/admin/privacy?view=requests&new=1&kind=ERASURE`, '_blank', 'noopener'),
          onCloseThread: record.onCloseThread,
          onConfirmClose: record.onConfirmClose,
          onCancelClose: record.onCancelClose,
        },
        onRowVerb,
        onBulk: (kind, inquiryIds) => {
          bulkKey.current = null
          if (kind === 'assign') readBulkPeople(inquiryIds)
          else setBulk({ kind: 'decline', ids: inquiryIds, model: { subject: subjectOf(inquiryIds.length), draft: emptyDecline, message: { to: null, held: { key: 'decline.message.many' } }, busy: false, notice: null, offline: false } })
        },
        bulk: {
          onAssign: (assigneeId) => void bulkAssign(assigneeId),
          onRetryPeople: () => bulk && readBulkPeople(bulk.ids),
          onDecline: (patch) => setBulk((now) => (now?.kind === 'decline' ? { ...now, model: { ...now.model, draft: { ...now.model.draft, ...patch } } } : now)),
          onSubmit: () => void bulkDecline(),
          onClose: () => setBulk(null),
        },
        onNew: () => go({ isNew: true, open: null }),
        newRequest: newRequest.actions, // B-TH-221
        record: record.actions,
        catalogue: catalogue.actions, // B-TH-233
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
        onDismissPageNotice: (key) =>
          setDismissed((now) => {
            const next = [...now.filter((one) => one !== key), key]
            keepDismissed(next)
            return next
          }),
      }}
    />
  )
}
