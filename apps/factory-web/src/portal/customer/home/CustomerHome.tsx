'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError } from '../../../lib/api/errors'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
import { composeDraftKey, readKeptCompose, subjectUsed } from '../../../lib/request-compose/model'
// B-TH-287: the New order draft on the server (the newer of it and this device's copy).
import { fromServerDraft, newerDraft } from '../../../lib/request-compose/server-draft'
import { fetchNewRequestDraft } from '../neworder/api'
import { fetchRequests, type RequestList } from '../requests/api'
// B-TH-238: the Messages card — the waiting requests' new messages (POST /threads/unread, the portal's own client).
import { readUnreadWith } from '../../../lib/last-message-cell/api'
import { messagesCardOf } from './model'
// B-TH-253: the projects the person was added to, in the Messages card (members only; fails closed).
import { fetchPortalProjects, type PortalProject } from '../projects/api'
import { PROJECTS_PERMISSION } from '../projects/model'
import { WithMessages } from '../../../record-panels/i18n'
import { searchPortal } from '../../shell/api'
import { PORTAL_AREAS, recordPageOf } from '../../shell/nav/portal-nav'
import { usePortalTasks } from '../../shell/PortalShell'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { TasksView } from '../../shell/view/TasksView'
import type { SearchGroupRow } from '../../shell/view/SearchView'
import {
  answerApproval,
  approvalFileBytes,
  fetchApproval,
  fetchHome,
  fetchNewDocuments,
  fetchNextOrders,
  fetchOpenItems,
  fetchPromiseHistory,
  fetchRecentMessages,
  statementHref,
  type ApprovalRead,
  type Conversation,
  type DocumentsRead,
  type HomeRead,
  type OpenItemsRead,
  type OrdersRead,
} from './api'
import { firstWaiting } from './model' // F-PR-15
import {
  answerProblem,
  answerRefusal,
  approvalIds,
  approvalOfTask,
  documentRowOf,
  isFirstVisit,
  isPdf,
  isPicture,
  neighbourOf,
  nextOrderRows,
  NS,
  orderCounts,
  readRecent,
  recentSearchesKey,
  requestHeld,
  tilesFor,
  tilesOf,
  withRecent,
} from './model'
import { homeBandOf } from './band'
import { CustomerHomeView, type HomeSearchModel, type PromiseWhy } from './view/CustomerHomeView'
import type { ApproveDialogModel } from './view/ApproveDialog'
import { useDocumentPreview } from '../documents/preview/usePreview'
import { useHomeWords } from './words'

/**
 * `/p/<party>` for a customer (B-W2b-187; design portal.customer.home, SCR-183; SAL-063, SAL-084, SAL-086): Find anything,
 * the frame's ONE task list (`usePortalTasks` + `TasksView`) with Approve / Review answered in the Approve pop-up, five
 * numbers at a glance, the next five deliveries, the new documents (preview and download, each open logged), our last
 * three messages, and the first step of a new customer. Every section reads on its own (one failing never empties
 * another) and again on the live channel. Nothing reaches anyone outside: every answer is the API's own command.
 */
export function CustomerHome() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'shell', 'ds-words']}>
      <HomeContainer />
    </WithMessages>
  )
}

/** A page of the portal is built (an area without pages, or one page of an area): its tile and links may lead there. */
const pageBuilt = (id: string): boolean => PORTAL_AREAS.some((area) => (area.id === id && area.built) || (area.pages ?? []).some((page) => page.id === id && page.built))

type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T | null }
const LOADING = { state: 'loading', value: null } as const

/** No connection: the browser says so, or the tab's one live channel lost its stream. */
function useOffline(live: string): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return !online || live === 'offline'
}

function HomeContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const tasks = usePortalTasks()
  const router = useRouter()
  const words = useHomeWords()
  const { t, locale } = words
  const portalWords = useT('portal')
  const prefix = frame.prefix
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const seesOrders = can('portal.salesOrders.view')
  const seesDocuments = can('portal.customerDocuments.view')
  const seesMessages = can('threads.read')
  const seesPayments = can('portal.payments.view')
  const seesApprovals = can('portal.approvals.view')
  // B-TH-253 (PROJ.portal-F01): a project shows only with portal.projects.view and only to the people the office added (the API's
  // members-only list); without the right — or when the read fails — no project row at all, never an error that says more.
  const seesProjects = seesMessages && can(PROJECTS_PERMISSION)
  const seesPrices = frame.access?.role?.seesPrices ?? false
  // F-PR-15: + My production (the In production tile opens it for a person who sees production).
  const built = useMemo(() => ({ orders: pageBuilt('orders.list'), documents: pageBuilt('documents'), returns: pageBuilt('returns'), production: pageBuilt('production') }), [])
  const preview = frame.me.preview

  const [home, setHome] = useState<Async<HomeRead>>(LOADING)
  const [orders, setOrders] = useState<Async<OrdersRead>>(LOADING)
  const [documents, setDocuments] = useState<Async<DocumentsRead>>(LOADING)
  const [messages, setMessages] = useState<Async<Conversation[]>>(LOADING)
  const [projects, setProjects] = useState<PortalProject[]>([]) // B-TH-253
  // B-TH-238: the open requests (what needs the customer first) and their new messages.
  const [waiting, setWaiting] = useState<Async<RequestList>>(LOADING)
  const [waitingUnread, setWaitingUnread] = useState<Record<string, number>>({})
  const [openItems, setOpenItems] = useState<OpenItemsRead | null>(null)
  const [why, setWhy] = useState<Record<string, PromiseWhy>>({})
  const [slow, setSlow] = useState(false)
  // B-TH-223 (P-HOME.actions-F02): the unsent New order kept on this device ("Draft: … · Continue"), read after mounting.
  // ---- B-TH-287: … and on the server ("Draft: … · saved 10:42 · Continue"): the newer of the two; a device copy the server no longer
  // keeps (sent or discarded on another computer) is not offered. Asked of the server only by a buyer outside a preview (the New
  // order draft is theirs: portal.orderRequests.manage); a failed read shows the device's copy as before.
  const [draft, setDraft] = useState<{ subject: string; at: string; where: 'server' | 'device' } | null>(null)
  const asksServer = can('portal.orderRequests.manage') && !frame.me.preview
  useEffect(() => {
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      storage = null
    }
    const kept = readKeptCompose(storage, composeDraftKey(frame.me.user.id, frame.me.party.code), Date.now())
    const line = (found: { draft: { subject: string; message: string; customerRef: string }; savedAt: number }, where: 'server' | 'device') => ({ subject: subjectUsed(found.draft) || found.draft.customerRef || '…', at: formatTime(new Date(found.savedAt).toISOString(), { locale }), where })
    const deviceLine = kept ? line(kept, 'device') : null
    if (!asksServer) {
      setDraft(deviceLine)
      return
    }
    let gone = false
    fetchNewRequestDraft(api).then(
      (read) => {
        if (gone) return
        const chosen = newerDraft(fromServerDraft(read), kept, true)
        setDraft(chosen && !chosen.forget ? line(chosen, chosen.source) : null)
      },
      () => {
        if (!gone) setDraft(deviceLine)
      },
    )
    return () => {
      gone = true
    }
  }, [api, asksServer, frame.me.user.id, frame.me.party.code, locale])
  // ---- end B-TH-287

  const keep = <T,>(set: (update: (current: Async<T>) => Async<T>) => void) => () => set((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
  const readHome = useCallback(() => {
    fetchHome(api)
      .then((value) => setHome({ state: 'ready', value }))
      .catch(keep(setHome))
    if (seesPayments) fetchOpenItems(api).then(setOpenItems, () => setOpenItems(null))
  }, [api, seesPayments])
  const readOrders = useCallback(() => {
    if (!seesOrders) return
    fetchNextOrders(api)
      .then((value) => setOrders({ state: 'ready', value }))
      .catch(keep(setOrders))
  }, [api, seesOrders])
  // B-TH-223: whether the customer has any request (its first step is done): one row is enough.
  const [requestsAll, setRequestsAll] = useState<number | null>(null)
  const readRequests = useCallback(() => {
    if (!seesOrders) return
    fetchRequests(api, { state: 'ALL', limit: 1 })
      .then((value) => setRequestsAll(value.rows.length))
      // Not read: unknown, so Home is not drawn as a first visit (the panels stay).
      .catch(() => undefined)
  }, [api, seesOrders])
  useEffect(() => {
    readRequests()
  }, [readRequests])
  const readDocuments = useCallback(() => {
    if (!seesDocuments) return
    fetchNewDocuments(api)
      .then((value) => setDocuments({ state: 'ready', value }))
      .catch(keep(setDocuments))
  }, [api, seesDocuments])
  const readMessages = useCallback(() => {
    if (!seesMessages) return
    fetchRecentMessages(api)
      .then((value) => setMessages({ state: 'ready', value: value.conversations }))
      .catch(keep(setMessages))
    // B-TH-253: the projects beside the conversations (a removed person's project is gone at the next read).
    if (seesProjects) fetchPortalProjects(api).then(setProjects, () => setProjects([]))
    else setProjects([])
  }, [api, seesMessages, seesProjects])
  // B-TH-238: the requests that wait for the customer, with the API's count (Orders & requests' first tile reads the same).
  const readWaiting = useCallback(() => {
    if (!seesOrders || !seesMessages) return
    fetchRequests(api, { state: 'OPEN', limit: 50 })
      .then((value) => setWaiting({ state: 'ready', value }))
      .catch(keep(setWaiting))
  }, [api, seesOrders, seesMessages])
  useEffect(() => {
    const asked = (waiting.value?.rows ?? []).filter((row) => row.state.needsYou)
    if (!seesMessages || asked.length === 0) {
      setWaitingUnread({})
      return
    }
    const control = new AbortController()
    readUnreadWith(api)(asked.map((row) => ({ recordType: 'Inquiry', recordId: row.id })), control.signal)
      .then((counts) => setWaitingUnread(Object.fromEntries(counts.map((count) => [count.recordId, count.newCount]))))
      // Not read: no marks (the rows stay; a count is never guessed).
      .catch(() => undefined)
    return () => control.abort()
  }, [api, seesMessages, waiting.value])
  const readAll = useCallback(() => {
    readHome()
    readOrders()
    readDocuments()
    readMessages()
    readWaiting()
  }, [readHome, readOrders, readDocuments, readMessages, readWaiting])

  useEffect(() => {
    readAll()
  }, [readAll])

  // "Still loading…" after about a second.
  const anyLoading = home.state === 'loading' || (seesOrders && orders.state === 'loading') || (seesDocuments && documents.state === 'loading') || (seesMessages && messages.state === 'loading') || tasks.model.state === 'loading'
  useEffect(() => {
    if (!anyLoading) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [anyLoading])

  // New task, quote sent, document issued, order status or promise changed, message posted: the panels follow in place.
  const liveEvents = useMemo(() => new Set([...(home.value?.live.events ?? []), ...(orders.value?.live.events ?? []), ...(documents.value?.live.events ?? [])]), [home.value, orders.value, documents.value])
  const live = usePortalLive({
    onChange: (change) => {
      if (liveEvents.has(change.type) || change.type.startsWith('partner_task.') || change.type.startsWith('partner_notification.')) readAll()
      // B-TH-238: a message or a request of this customer moved: the Messages card reads again in place.
      else if (change.type.startsWith('thread.') || change.type.startsWith('inquiry.') || change.type.startsWith('project.') /* B-TH-253 */) {
        readMessages()
        readWaiting()
      }
    },
    onReconnect: readAll,
  })
  const offline = useOffline(live)

  // ── Find anything ──
  const [search, setSearch] = useState<Omit<HomeSearchModel, 'recent'>>({ query: '', state: 'idle', groups: [], found: 0, capped: false })
  const [recent, setRecent] = useState<string[]>([])
  const searchSeq = useRef(0)
  const searchTimer = useRef<number | null>(null)
  useEffect(() => {
    try {
      setRecent(readRecent(window.localStorage.getItem(recentSearchesKey(frame.me.user.id))))
    } catch {
      setRecent([])
    }
  }, [frame.me.user.id])
  const remember = (query: string) => {
    setRecent((current) => {
      const next = withRecent(current, query)
      try {
        window.localStorage.setItem(recentSearchesKey(frame.me.user.id), JSON.stringify(next))
      } catch {
        // This device keeps nothing: the list lives for this visit only.
      }
      return next
    })
  }
  const runSearch = useCallback(
    async (query: string): Promise<string | null> => {
      const seq = ++searchSeq.current
      if (query.trim() === '') {
        setSearch((current) => ({ ...current, state: 'idle', groups: [], found: 0, capped: false }))
        return null
      }
      setSearch((current) => ({ ...current, state: 'searching' }))
      try {
        const answer = await searchPortal(api, query)
        if (seq !== searchSeq.current) return null
        const href = (result: { recordType: string; recordId: string }) => `${prefix}/open/${encodeURIComponent(result.recordType)}/${encodeURIComponent(result.recordId)}`
        const groups: SearchGroupRow[] = answer.groups.map((group) => ({
          group: group.group,
          label: portalWords(`search.group.${group.group}`),
          count: group.count,
          results: group.results.map((result) => ({ key: `${result.recordType}:${result.recordId}`, href: href(result), theirs: result.theirRef, ours: result.ourRef, subtitle: result.subtitle, when: result.date ? formatDate(result.date, { locale }) : null })),
        }))
        setSearch((current) => ({ ...current, state: answer.tooShort ? 'tooShort' : 'ready', found: answer.found, capped: answer.capped, groups }))
        return answer.single ? href(answer.single) : null
      } catch {
        if (seq === searchSeq.current) setSearch((current) => ({ ...current, state: 'error' }))
        return null
      }
    },
    [api, prefix, portalWords, locale],
  )
  const searchActions = {
    onQuery: (query: string) => {
      setSearch((current) => ({ ...current, query }))
      if (searchTimer.current) window.clearTimeout(searchTimer.current)
      searchTimer.current = window.setTimeout(() => void runSearch(query), 250)
    },
    onSubmit: () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current)
      const query = search.query
      void runSearch(query).then((one) => {
        if (query.trim().length >= 2) remember(query)
        if (one) router.push(one)
      })
    },
    onRecent: (query: string) => {
      setSearch((current) => ({ ...current, query }))
      void runSearch(query)
    },
    onClearRecent: () => {
      setRecent([])
      try {
        window.localStorage.removeItem(recentSearchesKey(frame.me.user.id))
      } catch {
        // Nothing kept on this device.
      }
    },
    onOpen: (href: string, event?: MouseEvent<HTMLAnchorElement>) => {
      remember(search.query)
      if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return
      event?.preventDefault()
      router.push(href)
    },
    onRetry: () => void runSearch(search.query),
  }

  // ── the moved promise: why ──
  const onWhy = (orderId: string) => {
    if (why[orderId]?.state === 'ready' || why[orderId]?.state === 'loading') return
    setWhy((current) => ({ ...current, [orderId]: { state: 'loading', words: null } }))
    fetchPromiseHistory(api, orderId)
      .then((history) => setWhy((current) => ({ ...current, [orderId]: { state: 'ready', words: history[0]?.reason.words[locale] ?? null } })))
      .catch(() => setWhy((current) => ({ ...current, [orderId]: { state: 'error', words: null } })))
  }

  // ── documents: preview (the lifted pop-up) and download, each open logged by the API ──
  const docHeld = preview ? t('held.preview') : offline ? t('held.offline') : null
  const viewer = useDocumentPreview({
    api,
    locale,
    held: docHeld,
    find: (id) => documents.value?.items.find((item) => item.id === id),
    // Opened documents are no longer new: the list and the count follow.
    onClosed: () => {
      readDocuments()
      readHome()
    },
  })
  const docs = useMemo(() => (documents.value?.items ?? []).map((item) => ({ item, row: { ...documentRowOf(item, locale), isNew: item.new && !viewer.opened.has(item.id) } })), [documents.value, locale, viewer.opened])
  const docIds = docs.map((entry) => entry.item.id)

  // ── the Approve pop-up ──
  const [approve, setApprove] = useState<(Omit<ApproveDialogModel, 'held' | 'position'> & { queue: string[] }) | null>(null)
  const filePicture = useRef<string | null>(null)
  const dropFile = () => {
    if (filePicture.current) URL.revokeObjectURL(filePicture.current)
    filePicture.current = null
  }
  const readApproval = (requestId: string, queue: string[]) => {
    dropFile()
    setApprove({ requestId, queue, state: 'loading', page: null, decision: null, comment: '', answer: 'idle', problem: null, field: null, file: null })
    fetchApproval(api, requestId)
      .then((page) => setApprove((current) => (current?.requestId === requestId ? { ...current, state: 'ready', page } : current)))
      .catch((error: unknown) => setApprove((current) => (current?.requestId === requestId ? { ...current, state: isApiError(error) && error.kind === 'not_found' ? 'gone' : 'error' } : current)))
  }
  const mayApprove = can('portal.approve') || (frame.access ? frame.access.capabilities.includes('portal.approve') : false)
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)
  const approveHeld = (page: ApprovalRead | null, busy: boolean): string | null => {
    if (preview) return t('held.preview')
    if (!mayApprove) return admins.length > 0 ? t('held.mayApproveAsk', { admins: admins.join(', ') }) : t('held.mayApprove')
    if (offline) return t('held.offline')
    if (busy) return t('held.busy')
    if (!page) return t('held.reading')
    const own = requestHeld(page)
    return own ? t(own) : null
  }
  const signApproval = (typedName: string) => {
    const current = approve
    if (!current?.page || current.answer === 'busy' || approveHeld(current.page, false)) return
    const problem = answerProblem(current.decision, current.comment)
    if (problem) {
      setApprove({ ...current, problem: problem.key, field: problem.field })
      return
    }
    const page = current.page
    setApprove({ ...current, answer: 'busy', problem: null, field: null })
    answerApproval(api, page.request.id, { decision: current.decision as ApprovalDecision, answer: current.comment.trim() || null, typedName: typedName.trim(), version: page.request.version })
      .then((answered) => {
        setApprove((now) => (now?.requestId === page.request.id ? { ...now, page: answered, answer: 'done' } : now))
        frame.refreshTasks()
        readHome()
      })
      .catch((error: unknown) => {
        const refusal = answerRefusal(isApiError(error) ? error.kind : null)
        setApprove((now) => (now?.requestId === page.request.id ? { ...now, answer: 'idle', problem: refusal.key, field: null, ...(refusal.gone ? { state: 'gone' as const } : {}) } : now))
        if (refusal.reload) fetchApproval(api, page.request.id).then((fresh) => setApprove((now) => (now?.requestId === page.request.id ? { ...now, page: fresh } : now)), () => undefined)
      })
  }
  const openFile = (fileId: string | null) => {
    dropFile()
    const page = approve?.page
    if (!fileId || !page) {
      setApprove((current) => (current ? { ...current, file: null } : current))
      return
    }
    const file = page.files.find((entry) => entry.id === fileId)
    if (!file) return
    const pdf = isPdf(file.contentType)
    setApprove((current) => (current ? { ...current, file: { id: fileId, name: file.originalName, state: 'loading', src: null, pdf } } : current))
    approvalFileBytes(api, fileId)
      .then((bytes) => {
        const src = pdf ? bytes : isPicture(file.contentType) ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType })) : null
        if (typeof src === 'string') filePicture.current = src
        setApprove((current) => (current?.file?.id === fileId ? { ...current, file: { ...current.file, state: src ? 'ready' : 'error', src } } : current))
      })
      .catch(() => setApprove((current) => (current?.file?.id === fileId ? { ...current, file: { ...current.file, state: 'error' } } : current)))
  }
  const stepApproval = (step: 1 | -1) => {
    if (!approve) return
    const next = neighbourOf(approve.queue, approve.requestId, step)
    if (next) readApproval(next, approve.queue)
  }
  const closeApproval = () => {
    dropFile()
    setApprove(null)
  }
  useEffect(() => () => dropFile(), [])

  // ── the band ──
  const asOf = home.value?.asOf ?? null
  usePortalBand(
    homeBandOf({
      t,
      asOf: asOf ? formatTime(asOf, { locale }) : null,
      statement: seesPayments && seesPrices && !preview ? statementHref(locale) : null,
      emailSettings: !preview,
      ordersKey: built.orders && seesOrders,
    }),
  )

  // ── the model ──
  const openTasks = tasks.model.groups.reduce((sum, group) => sum + group.rows.filter((row) => !row.done).length, 0)
  const counts = orderCounts(orders.value)
  const first = isFirstVisit({ tasks: tasks.model.state, openTasks, seesOrders, ordersAll: seesOrders ? (orders.state === 'ready' ? counts.all : null) : 0, newDocuments: seesDocuments ? (documents.value?.items.length ?? null) : 0, requestsAll })
  const buyer = can('portal.orderRequests.manage')
  const newOrderHref = buyer && pageBuilt('orders.new') ? `${prefix}/orders/new` : null
  // B-TH-223: New order is the page's main button (not in a preview: nothing is sent from one).
  const tileDefs = tilesFor(built, can)
  const queue = approvalIds(tasks.model.groups)
  // ---- F-PR-15 (06-tree B.4 P-HOME-waiting): the first five of What waits for you and "All 9 waiting" → Waiting for you, once that
  // page is built and the person may open it (F-PR-14); until then the list stays whole (never a door to nowhere, nothing hidden).
  const waitingPage = pageBuilt('home.waiting') && can('portal.approvals.view')
  const firstFive = waitingPage && tasks.model.state === 'ready' ? firstWaiting(tasks.model.groups) : null
  const tasksShown = firstFive ? { ...tasks.model, groups: firstFive.groups } : tasks.model
  const tasksMore = firstFive?.more ? { href: `${prefix}/waiting`, label: t('waiting.all', { count: firstFive.open }) } : null
  // ---- end F-PR-15

  return (
    <CustomerHomeView
      model={{
        prefix,
        search: can('portal.search') ? { ...search, recent } : null,
        // B-TH-223
        start: { newOrderHref: preview ? null : newOrderHref, buyer, admins, draft: buyer && !preview ? draft : null },
        welcome: first
          ? {
              name: frame.me.user.displayName.split(' ')[0] ?? frame.me.user.displayName,
              company: frame.me.company.name,
              buyer,
              newOrderHref,
              catalogueHref: pageBuilt('quotes.catalogue') && can('portal.catalogue.view') ? `${prefix}/catalogue` : null,
              admins,
            }
          : null,
        tiles: tileDefs.some((def) => can(def.permission)) ? { state: home.state, items: tilesOf(tileDefs, home.value, can, seesPrices ? { openItems, format: words.money } : null) } : null,
        orders: seesOrders
          ? {
              state: orders.state,
              items: nextOrderRows(orders.value, locale, prefix, words.day),
              open: counts.open,
              seeAllHref: built.orders ? `${prefix}/orders` : null,
              newOrderHref,
              why,
            }
          : null,
        documents: seesDocuments ? { state: documents.state, items: docs.map((entry) => entry.row), seeAllHref: built.documents ? `${prefix}/documents` : null, busy: viewer.busy, problem: viewer.problem ? t('documents.openFailed') : null, held: docHeld } : null,
        // B-TH-238: what needs the customer first, then new messages, the account's conversation — the session's own reads only.
        // The card waits for the requests' first read too (what needs the customer comes first: nothing jumps in above).
        messages: seesMessages
          ? {
              state: messages.state === 'ready' && seesOrders && waiting.state === 'loading' ? 'loading' : messages.state,
              company: frame.me.company.name,
              card: messages.value && !(seesOrders && waiting.state === 'loading')
                ? messagesCardOf({
                    prefix,
                    partyId: frame.me.party.id,
                    locale,
                    waiting: waiting.value?.rows ?? [],
                    needsYouCount: waiting.value?.counts.needsYou ?? null,
                    conversations: messages.value,
                    unread: waitingUnread,
                    recordPage: (type, id) => recordPageOf(frame.kinds, type, id),
                    projects, // B-TH-253
                  })
                : null,
              needsYouHref: built.orders ? `${prefix}/orders?chip=NEEDS_YOU` : null,
            }
          : null,
        slow,
        approve: approve
          ? {
              ...approve,
              held: approveHeld(approve.page, approve.answer === 'busy'),
              position: approve.queue.length > 1 && approve.queue.includes(approve.requestId) ? { index: approve.queue.indexOf(approve.requestId) + 1, count: approve.queue.length } : null,
            }
          : null,
        document: viewer.dialog,
      }}
      actions={{
        search: searchActions,
        onRetryTiles: () => {
          setHome(LOADING)
          readHome()
        },
        onRetryOrders: () => {
          setOrders(LOADING)
          readOrders()
        },
        onRetryDocuments: () => {
          setDocuments(LOADING)
          readDocuments()
        },
        onRetryMessages: () => {
          setMessages(LOADING)
          readMessages()
          readWaiting()
        },
        onWhy,
        onPreview: (id) => {
          const found = docs.find((entry) => entry.item.id === id)
          if (found) viewer.open(found.item, docIds)
        },
        onDownload: (id) => {
          const found = docs.find((entry) => entry.item.id === id)
          if (found) void viewer.download(found.item)
        },
        onAsk: () => frame.ask(null),
        approve: {
          onClose: closeApproval,
          onRetry: () => approve && readApproval(approve.requestId, approve.queue),
          onDecision: (decision) => setApprove((current) => (current ? { ...current, decision, problem: current.field === 'decision' ? null : current.problem, field: current.field === 'decision' ? null : current.field } : current)),
          onComment: (comment) => setApprove((current) => (current ? { ...current, comment, ...(current.field === 'comment' ? { problem: null, field: null } : {}) } : current)),
          onSign: signApproval,
          onStep: stepApproval,
          onOpenFile: openFile,
        },
        document: viewer.actions,
      }}
      tasks={
        <TasksView
          model={tasksShown /* F-PR-15 */}
          more={tasksMore /* F-PR-15 */}
          onDone={tasks.onDone}
          onUndo={tasks.onUndo}
          onRetry={tasks.onRetry}
          verbFor={(row) => {
            const requestId = seesApprovals ? approvalOfTask(row) : null
            return requestId ? { label: t(`verb.${row.kind}`), onRun: () => readApproval(requestId, queue) } : null
          }}
        />
      }
    />
  )
}
