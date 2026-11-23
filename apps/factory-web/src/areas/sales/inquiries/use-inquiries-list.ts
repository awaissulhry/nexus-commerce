'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
// B-TH-285: the inquiry addresses (⋯) and the band's door line.
import { useInquiryAddresses } from './addresses/use-inquiry-addresses'
import { doorLine } from './addresses/model'
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
// ---- F-CQ-103 (customer page › Quotes & incoming): the host's kinds and door, Most urgent first on one page.
import { DEFAULT_TILE, rankedRows, rankHeld, type IncomingRank } from './model'
import type { IncomingKind, ListTile } from './model'
import { useInquiry } from './use-inquiry'
// B-TH-228: which receipts stay on the page when the queue moves on.
import { receiptStays } from './model'
import { useNewRequest } from './use-new-request'
import type { BulkDialog, InquiriesActions, InquiriesModel, ListSlots } from './view/InquiriesView'
import { pictureReader } from '../../../lib/record-picture/api' // F-SA-212: the one picture part's batch read
import type { ListScope } from '../_shared/scoped-list-tools/ScopedListTools' // F-SA-277

/**
 * F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the ONE Incoming list, for every page that shows it — Sales › Incoming
 * and the customer page's Quotes & incoming. The body of the Incoming page's container moved here as it was (SCR-105: Incoming's one
 * read over every door, page by page, "Customer replies", the request or the catalogue order beside the list, New request, Assign
 * to… and Decline N, live changes behind "N updates · Show"). The host says:
 *
 *   basePath   the list's own path under /w/<company> ('/sales/incoming'): where the page writes its address and where Copy link of
 *              a saved view opens; the company prefix is the session's, never parsed from the path
 *   locked     `party`: one customer's requests — in EVERY read (the rows, the tiles' counts, Customer replies, the tools' query for
 *              Export ▾, Export N and saved views), never cleared (Clear all keeps it); no From switcher and no customer chip
 *   embedded   the host draws what sits above the list: no band (title, as of, ⋯ Inquiry addresses, New request), no tiles, no
 *              page notices (and their reads)
 *   terms      'address' (default: Sales › Incoming — `?tile=&kind=&status=&source=&company=&party=&q=…`) or 'memory' (two lists on
 *              one page: typing in one never narrows the other, and the page's own terms stay; the list's tools read `scope`)
 *   pane       'own' (default: the request or the catalogue order opens in the reading pane beside the list) or 'host' (no SplitPane:
 *              the page's dock is the pane — a row's click is the host's; Enter, a link and ⋯ Open go to the row's own page)
 *   onRowClick a row's click (the customer page docks the request's thread). A change request opens Home › Approvals' review
 *              window on every host, as on Incoming (placeOf / approvalsHref).
 */

/** F-SA-277: Incoming's one list key (PR-11: kept after the rename; its export source, its saved views), on every host. */
export const INQUIRIES_LIST_KEY = 'sales.inquiries' as const

export interface InquiriesListHost {
  /** The list's own path under /w/<company>. */
  readonly basePath: string
  /** Held for every read, never cleared. */
  readonly locked?: { readonly party?: string } | null
  /** The host draws what sits above the list. */
  readonly embedded?: boolean
  /** Where the list's terms live (default: the address). */
  readonly terms?: 'address' | 'memory'
  /** Who draws the request beside the list (default: the list's own reading pane). */
  readonly pane?: 'own' | 'host'
  /** A row's click (never a change request's: that opens Home › Approvals). */
  readonly onRowClick?: (row: IncomingRow, newTab: boolean) => void
  // ---- F-CQ-103 / F-CQ-104 (customer page › Quotes & incoming, 13-backend §11 row 5): the host's own options — (a) this host only;
  // Sales › Incoming gives none and keeps its list as it was.
  /** Some kinds only, in every read, every count and the tools' query (the customer's tab: requests and portal orders). */
  readonly kinds?: readonly IncomingKind[] | null
  /** The saved row the list opens on (the band's door; else Open); Clear filters keeps it; a new door starts the list again on it. */
  readonly defaultTile?: ListTile | null
  /** The order the list opens on ('urgent': Most urgent first, ranked on one page). */
  readonly defaultRank?: IncomingRank | null
  /** 'host': the host's columns (Number first, no Customer column; the set by `room`). */
  readonly columns?: 'host'
  /** The list's own room in px (the host measures its root; never the window). */
  readonly room?: number | null
  /** One customer's tab: a live change that names another customer (or a prospect) is not counted in "N updates" (Q2-B9). */
  readonly liveParty?: string | null
  /** The customer's one name on this host (the chips say it, never a row's own: P0-B9). */
  readonly customerName?: string | null
  // ---- end F-CQ-103 / F-CQ-104
}

type Lock = Pick<InquiriesListHost, 'locked' | 'pane'>

/**
 * F-CQ-103 (Q2-B9): whether a live change counts in "N updates": a request, a portal order (never a draft's change: drafts are not
 * in this list), a change request; on one customer's tab only one that names this customer (or names none); Customer replies counts
 * a message.
 */
export function incomingLiveCounts(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, liveParty: string | null, repliesView: boolean): boolean {
  if (change.type === 'portal_order_request.draft_changed') return false
  const kind = change.type.startsWith('inquiry.') || change.type.startsWith('portal_order_request.') || change.type.startsWith('order_change_request.')
  if (!kind) return repliesView && change.type.startsWith('thread.')
  if (liveParty && 'partyId' in change.fields) return change.fields.partyId === liveParty
  return true
}

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

// ---- F-SA-277: the host's lock and terms, pure (a test holds them without a DOM) ----
/** The address every read takes: the host's lock over the list's own terms (a locked customer: never "prospects only"). */
export function incomingLocked(host: Pick<InquiriesListHost, 'locked'>, address: ListAddress): ListAddress {
  const party = host.locked?.party
  return party ? { ...address, party, prospect: false } : address
}

/** The address a list in memory keeps: as the page's address would read it (addressOf over addressText), the lock in, nothing open beside the list when the host's dock is the pane. */
export function incomingMemory(host: Lock, next: ListAddress): ListAddress {
  const read = incomingLocked(host, addressOf(new URLSearchParams(addressText(next).replace(/^\?/, ''))))
  return host.pane === 'host' ? { ...read, open: null, catalogue: null, tab: 'request' } : read
}

/** The address Sales › Incoming writes: its own terms on its own path (as before the lift). */
export const incomingAddress = (base: string, address: ListAddress): string => `${base}${addressText(address)}`

/** The list's terms as its tools read them on an embedding host (Export ▾, Export N, saved views): the lock in, nothing open. */
export function incomingToolsQuery(host: Pick<InquiriesListHost, 'locked' | 'kinds'>, address: ListAddress): string {
  const text = addressText({ ...incomingLocked(host, address), open: null, catalogue: null, tab: 'request', isNew: false, mail: null, rank: null }).replace(/^\?/, '')
  if (!host.kinds || host.kinds.length === 0) return text
  // F-CQ-103: the host's kinds go with the file's terms (screen = file: no change request in the customer tab's file).
  const params = new URLSearchParams(text)
  params.set('kinds', host.kinds.join(','))
  return params.toString()
}

/** A saved view's terms back into the list's memory (a lock stays the host's). */
export const incomingFromQuery = (host: Lock, query: string): ListAddress => incomingMemory(host, addressOf(new URLSearchParams(query.replace(/^\?/, ''))))

/** A row's own page (Incoming's ⌘ rule): a request's full page (the list kept for Back), any other kind its own place — a catalogue order beside Incoming, a change request in Home › Approvals. */
export const rowPageHref = (prefix: string, row: Pick<IncomingRow, 'kind' | 'id' | 'opens'>, address: ListAddress): string => (placeOf(row) === 'request' ? fullPageHref(prefix, row.id, address) : rowHref(prefix, address, row))
// ---- end F-SA-277

/** The ONE Incoming list: the model InquiriesView draws, its actions and slots, for the host. */
export function useInquiriesList(host: InquiriesListHost): { model: InquiriesModel; actions: InquiriesActions; slots: ListSlots; scope: ListScope } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])
  // ---- F-SA-277: the host — the list's path, its lock, where its terms live, who draws the pane ----
  const base = `${prefix}${host.basePath}`
  const memory = host.terms === 'memory'
  const paneHost = host.pane === 'host'
  const embedded = !!host.embedded
  const lock = host.locked?.party ?? null
  const lockHost = useMemo<Lock>(() => ({ locked: lock ? { party: lock } : null, pane: host.pane }), [lock, host.pane])
  // ---- F-CQ-103: the host's door (its saved row), its kinds, its order
  const hostTile = host.defaultTile ?? null
  const kindsKey = host.kinds?.join(',') ?? ''
  const kinds = useMemo<readonly IncomingKind[] | null>(() => (kindsKey ? (kindsKey.split(',') as IncomingKind[]) : null), [kindsKey])
  const liveParty = host.liveParty ?? null
  const [kept, setKept] = useState<ListAddress>(() => incomingMemory(lockHost, hostTile ? { ...HOME_ADDRESS, tile: hostTile } : HOME_ADDRESS))
  // A new door starts the list again on its saved row (the State and the row open under the old door go; once, not on arrival).
  const lastTile = useRef(hostTile)
  useEffect(() => {
    if (lastTile.current === hostTile) return
    lastTile.current = hostTile
    setKept((now) => incomingMemory(lockHost, { ...now, tile: hostTile ?? DEFAULT_TILE, status: null }))
  }, [hostTile, lockHost])
  // ---- end F-CQ-103
  const fromAddress = useMemo(() => addressOf(params), [params])
  const address = memory ? kept : fromAddress
  // ---- end F-SA-277
  const addressRef = useRef(address)
  addressRef.current = address
  // F-SA-277: the page writes its address; a list in memory keeps its terms (the lock stays the host's).
  const go = useCallback(
    (next: Partial<ListAddress>) => {
      if (memory) return setKept((now) => incomingMemory(lockHost, { ...now, ...next }))
      router.replace(incomingAddress(base, { ...addressRef.current, ...next }), { scroll: false })
    },
    [router, base, memory, lockHost],
  )

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
  // F-SA-277: every read takes the host's lock.
  const read = useMemo(() => incomingLocked(lockHost, address), [lockHost, address])
  const query = useMemo(() => ({ ...queryOf(read), ...(kinds ? { kinds } : {}) /* F-CQ-103 */ }), [read, kinds])
  const queryKey = JSON.stringify(query)

  const repliesView = address.tile === CUSTOMER_REPLIES
  const repliesKey = JSON.stringify({ companyId: read.company, partyId: read.prospect ? null : read.party })
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
  // F-CQ-103 (C7): Most urgent first ranks the rows when they are the whole list (one page); with more pages they keep the server's order.
  const rank: IncomingRank = address.rank ?? host.defaultRank ?? 'arrival'
  const list = useMemo<IncomingList | null>(() => {
    if (!pages || pages.length === 0) return null
    const next = pages[pages.length - 1]!.next
    return { ...pages[0]!, rows: repliesView ? [] : rankedRows(mergePages(pages), rank, next === null), next }
  }, [pages, repliesView, rank])
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
    // F-SA-277: a locked customer has no From switcher (nothing to read).
    if (!can.view || !can.parties || lock) return
    const controller = new AbortController()
    listCustomers(api, companyId, controller.signal)
      .then(setCustomers)
      .catch(() => setCustomers(null))
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId, lock])

  // ---- B-TH-216: the one notice's facts (each read only for who may act on it), the Picture cell, a row opens its request ----
  const companies = useMemo(() => session.companies.map((entry) => ({ id: entry.id, name: entry.name, code: entry.code })), [session.companies]) // B-TH-233: + code (list-F12)
  const [noticeFacts, setNoticeFacts] = useState<NoticeFacts>({})
  const mayNumbering = session.permissions.includes('numbering.view')
  const maySort = session.permissions.includes('email.triage')
  useEffect(() => {
    // F-SA-277: an embedding host draws no page notices (nor reads their facts).
    if (!can.view || embedded) return
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
  }, [api, can.view, mayNumbering, maySort, companies, embedded])
  // F-SA-212: a page's pictures in ONE call (lib/record-picture; #1649's browserAddress kept there).
  const readPictures = useMemo(() => pictureReader(api), [api])
  // ---- end B-TH-216 ----

  const live = useLiveBus(
    {
      onChange: (change) => {
        // B-TH-233: every kind of row changes live — a request, a catalogue order, a change request (the rows wait behind "N updates");
        // Customer replies: a message moves a conversation in or out of the view. F-CQ-103: never a draft's change; on a customer's tab
        // only that customer's (Q2-B9).
        if (incomingLiveCounts(change, liveParty, repliesView)) setUpdates((count) => count + 1)
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
  // F-SA-277: with the host's dock as the pane, a row opens at its own page (Enter, a link, ⋯ Open; ⌘: a new tab).
  const openPage = useCallback(
    (row: IncomingRow, newTab: boolean) => {
      const href = rowPageHref(prefix, row, addressRef.current)
      if (newTab) window.open(href, '_blank', 'noopener')
      else router.push(href)
    },
    [prefix, router],
  )
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
      // F-SA-277: no reading pane on this host — the verb is on the request's own page.
      if (paneHost) return openPage(row, false)
      setPendingVerb(verb)
      go({ open: row.id, catalogue: null, tab: verb === 'quote' ? 'quote' : 'request' })
    },
    [go, paneHost, openPage],
  )

  // ---- B-TH-285: ⋯ Inquiry addresses (the orders@ door's setting) and the band's line while that door is not open --------------
  const [addressesOpen, setAddressesOpen] = useState(false)
  // F-SA-277: an embedding host draws no band (no door line, no ⋯ Inquiry addresses): nothing is read for it.
  const addresses = useInquiryAddresses({ api, companyId, open: addressesOpen, may: { view: can.view && !embedded, identities: session.permissions.includes('email.send') && !embedded, integrations: session.permissions.includes('integrations.view') && !embedded }, offline })
  const door = doorLine(addresses.model.loaded.status === 'ready' ? addresses.model.loaded.value.answer.addresses : null, addresses.model.live, addresses.model.domains)
  // ---- end B-TH-285

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
    partyId: lock, // F-CQ-104: on one customer's tab "New request for <customer>…" starts with the customer set
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

  const model: InquiriesModel = {
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
    // B-TH-285; F-SA-277: an embedding host draws no band.
    ...(embedded ? {} : { addresses: { open: addressesOpen, model: addresses.model, door } }),
    // ---- F-SA-277: the host
    embedded,
    paneMode: paneHost ? 'host' : 'own',
    locked: !!lock,
    // ---- end F-SA-277
    // ---- F-CQ-103 / F-CQ-104: the host's face (its kinds, its door's row, the order and whether it is held, columns by its room)
    ...(kinds ? { kinds } : {}),
    ...(hostTile ? { homeTile: hostTile } : {}),
    rank,
    rankHeld: rankHeld(rank, list),
    ...(host.columns ? { columns: host.columns } : {}),
    room: host.room ?? null,
    customerName: host.customerName ?? null,
    // ---- end F-CQ-103 / F-CQ-104
  }

  const slots: ListSlots = { thread: record.thread, catalogueThread: catalogue.thread }

  const actions: InquiriesActions = {
    onAddress: (patch) => go({ ...patch, open: patch.open ?? null, catalogue: patch.catalogue ?? null }),
    // F-SA-277: a lock comes back (the memory keeps it; the page has none). F-CQ-103: and the host's door (its saved row).
    onClearFilters: () => go({ ...HOME_ADDRESS, ...(hostTile ? { tile: hostTile } : {}) }),
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    // B-TH-233: a row opens by its kind — a request or a catalogue order beside the list, a change request in Home › Approvals.
    // F-SA-277: with the host's dock as the pane, at its own page.
    onOpen: paneHost
      ? (id) => {
          const row = id ? rowsRef.current.find((one) => one.id === id) : undefined
          if (row) openPage(row, false)
        }
      : openId,
    // B-TH-216 (grid-F29 as on the Orders sheet): the rest of a row opens it; ⌘ / Ctrl a request's full page (any other's own place) in a new tab.
    onOpenRow: (row, newTab) => {
      const place = placeOf(row)
      if (place === 'approvals') return newTab ? void window.open(approvalsHref(prefix, row.opens.id), '_blank', 'noopener') : router.push(approvalsHref(prefix, row.opens.id))
      // F-SA-277: the host's row click (the customer page docks the request's thread); a host-drawn pane without one: the row's page.
      if (host.onRowClick) return host.onRowClick(row, newTab)
      if (paneHost) return openPage(row, newTab)
      if (!newTab) return openId(row.id)
      window.open(place === 'request' ? fullPageHref(prefix, row.id, addressRef.current) : rowHref(prefix, addressRef.current, row), '_blank', 'noopener')
    },
    onMore: () => void readMore(),
    onGo: (href, newTab) => (newTab ? void window.open(href, '_blank', 'noopener') : router.push(href)),
    readPictures, // F-SA-212
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
    // B-TH-285
    addresses: { ...addresses.actions, onOpen: () => setAddressesOpen(true), onClose: () => setAddressesOpen(false) },
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
  }

  // F-SA-277: an embedding host's list tools read the list's own terms (its lock in) and write a saved view's back into its memory.
  const scope: ListScope = { query: incomingToolsQuery({ ...lockHost, kinds }, address), onGoTo: (query) => setKept(incomingFromQuery(lockHost, query)) }

  return { model, actions, slots, scope }
}
