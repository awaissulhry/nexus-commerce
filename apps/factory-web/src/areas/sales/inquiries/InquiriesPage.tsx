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
  LIST_LIMIT,
  listAssignees,
  listCustomers,
  listInquiries,
  mailToSortCount,
  readPicture,
  type InquiryList,
  type InquiryRow,
  type PartyOption,
} from './api'
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
  type ListAddress,
  type Notice,
  type NoticeFacts,
  type RowVerb,
} from './model'
import type { RecordVerb } from './record-model'
import { useInquiry } from './use-inquiry'
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

  // ---- the list --------------------------------------------------------------------------------------------------------------
  const [list, setList] = useState<InquiryList | null>(null)
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

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      const answer = await listInquiries(api, JSON.parse(queryKey) as ReturnType<typeof queryOf>)
      if (id !== readId.current) return
      setList(answer)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, queryKey])

  useEffect(() => {
    setList(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!can.view || !can.parties) return
    const controller = new AbortController()
    listCustomers(api, companyId, controller.signal)
      .then(setCustomers)
      .catch(() => setCustomers(null))
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId])

  // ---- B-TH-216: the one notice's facts (each read only for who may act on it), the Picture cell, a row opens its request ----
  const companies = useMemo(() => session.companies.map((entry) => ({ id: entry.id, name: entry.name })), [session.companies])
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
        if (change.type.startsWith('inquiry.')) setUpdates((count) => count + 1)
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
  useEffect(() => setUnreadTick((tick) => tick + 1), [address.open])
  const unreadRows = useMemo(() => (list ? list.rows.map((row) => ({ recordType: 'Inquiry', id: row.id })) : []), [list])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  // ---- end B-TH-230

  // ---- the inquiry in its DetailModal ------------------------------------------------------------------------------------------
  const [pendingVerb, setPendingVerb] = useState<RecordVerb | null>(null)
  const ids = useMemo(() => (list ? list.rows.map((row) => row.id) : []), [list])
  const idsRef = useRef(ids)
  idsRef.current = ids
  const record = useInquiry({
    inquiryId: address.open,
    tab: address.tab,
    onTab: (tab) => go({ tab }),
    onChanged: () => void load(),
    onDecided: (inquiryId) => {
      const next = nextAfter(idsRef.current, inquiryId)
      if (next && next !== inquiryId) go({ open: next, tab: 'request' })
    },
    pendingVerb,
    onPendingDone: () => setPendingVerb(null),
  })
  const detailNotice = record.model.notice
  useEffect(() => {
    // A decision's receipt stays on the page when the queue moves on to the next inquiry.
    if (detailNotice && (detailNotice.key.startsWith('done.quote') || detailNotice.key === 'done.decline' || detailNotice.key === 'done.lost')) setNotice(detailNotice)
  }, [detailNotice])

  const onRowVerb = useCallback(
    (row: InquiryRow, verb: RowVerb) => {
      setPendingVerb(verb)
      go({ open: row.id, tab: verb === 'quote' ? 'quote' : 'request' })
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
  const itemsOf = (inquiryIds: readonly string[]) => (list?.rows ?? []).filter((row) => inquiryIds.includes(row.id)).map((row) => ({ inquiryId: row.id, version: row.version }))
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
        limit: LIST_LIMIT,
        newRequest: newRequest.model, // B-TH-221
        bulk: bulk ? ({ ...bulk, model: { ...bulk.model, offline } } as BulkDialog) : null,
        detail: address.open ? record.model : null,
        // B-TH-217: the pane's facts — handled meanwhile, "Close thread…", the menu's rights.
        pane: address.open ? { handled: record.handled, closing: record.closing, rights: { erase: session.permissions.includes('privacy.requests.manage'), closeThread: session.permissions.includes('threads.manage') } } : null,
        companies, // B-TH-216
        noticeFacts, // B-TH-216
        unread: readsThreads ? unread : null, // B-TH-230
      }}
      slots={{ thread: record.thread }}
      actions={{
        onAddress: (patch) => go({ ...patch, open: patch.open ?? null }),
        onClearFilters: () => go({ ...HOME_ADDRESS }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (inquiryId) => go({ open: inquiryId, tab: inquiryId === addressRef.current.open ? addressRef.current.tab : 'request' }),
        // B-TH-216 (grid-F29 as on the Orders sheet): the rest of a row opens the request; ⌘ / Ctrl its full page in a new tab.
        onOpenRow: (inquiryId, newTab) => (newTab ? window.open(fullPageHref(prefix, inquiryId, addressRef.current), '_blank', 'noopener') : go({ open: inquiryId, tab: 'request' })),
        loadPicture,
        // B-TH-217: the pane's own acts.
        pane: {
          onNext: () => {
            const next = nextAfter(idsRef.current, addressRef.current.open ?? '')
            go({ open: next && next !== addressRef.current.open ? next : null, tab: 'request' })
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
