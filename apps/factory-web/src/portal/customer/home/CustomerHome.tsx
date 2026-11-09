'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError } from '../../../lib/api/errors'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
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
  documentBytes,
  fetchApproval,
  fetchDocument,
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
import {
  answerProblem,
  answerRefusal,
  approvalIds,
  approvalOfTask,
  documentRowOf,
  isFirstVisit,
  isPdf,
  isPicture,
  mainFileOf,
  neighbourOf,
  nextOrderRows,
  NS,
  orderCounts,
  readRecent,
  recentSearchesKey,
  replyHref,
  requestHeld,
  tilesFor,
  tilesOf,
  versionLines,
  withRecent,
} from './model'
import { homeBandOf } from './band'
import { CustomerHomeView, type HomeSearchModel, type PromiseWhy } from './view/CustomerHomeView'
import type { ApproveDialogModel } from './view/ApproveDialog'
import type { DocumentDialogModel } from './view/DocumentDialog'
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

/** Saves bytes as a file on this device (a document the person chose to download). */
function saveBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  const seesPrices = frame.access?.role?.seesPrices ?? false
  const built = useMemo(() => ({ orders: pageBuilt('orders.list'), documents: pageBuilt('documents'), returns: pageBuilt('returns') }), [])
  const preview = frame.me.preview

  const [home, setHome] = useState<Async<HomeRead>>(LOADING)
  const [orders, setOrders] = useState<Async<OrdersRead>>(LOADING)
  const [documents, setDocuments] = useState<Async<DocumentsRead>>(LOADING)
  const [messages, setMessages] = useState<Async<Conversation[]>>(LOADING)
  const [openItems, setOpenItems] = useState<OpenItemsRead | null>(null)
  const [why, setWhy] = useState<Record<string, PromiseWhy>>({})
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [docBusy, setDocBusy] = useState<string | null>(null)
  const [docProblem, setDocProblem] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)

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
  }, [api, seesMessages])
  const readAll = useCallback(() => {
    readHome()
    readOrders()
    readDocuments()
    readMessages()
  }, [readHome, readOrders, readDocuments, readMessages])

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

  // ── documents: preview (the pop-up) and download, each open logged by the API ──
  const docs = useMemo(() => (documents.value?.items ?? []).map((item) => ({ item, row: { ...documentRowOf(item, locale), isNew: item.new && !opened.has(item.id) } })), [documents.value, locale, opened])
  const docHeld = preview ? t('held.preview') : offline ? t('held.offline') : null
  const [docDialog, setDocDialog] = useState<(Omit<DocumentDialogModel, 'position'> & { ids: string[] }) | null>(null)
  const pictureUrl = useRef<string | null>(null)
  const dropPicture = () => {
    if (pictureUrl.current) URL.revokeObjectURL(pictureUrl.current)
    pictureUrl.current = null
  }
  const openDocument = (id: string, ids: string[]) => {
    const found = docs.find((entry) => entry.item.id === id)
    if (!found) return
    const file = mainFileOf(found.item)
    const pdf = file ? isPdf(file.contentType) : false
    dropPicture()
    setDocDialog({ row: found.row, state: 'loading', src: null, pdf, versions: [], withdrawn: null, downloading: false, problem: null, ids })
    documentBytes(api, id, 'preview')
      .then(({ bytes }) => {
        let src: Uint8Array | string = bytes
        if (!pdf && file && isPicture(file.contentType)) {
          src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType }))
          pictureUrl.current = src
        }
        setOpened((current) => new Set(current).add(id))
        setDocDialog((current) => (current?.row.id === id ? { ...current, state: 'ready', src: pdf || typeof src === 'string' ? src : null } : current))
      })
      .catch(() => setDocDialog((current) => (current?.row.id === id ? { ...current, state: 'error' } : current)))
    fetchDocument(api, id)
      .then((one) =>
        setDocDialog((current) =>
          current?.row.id === id
            ? {
                ...current,
                versions: one.versions.length > 1 ? versionLines(one.versions) : [],
                withdrawn: one.withdrawn?.replacedBy ? { title: one.withdrawn.replacedBy.title[locale], version: one.withdrawn.replacedBy.version } : null,
              }
            : current,
        ),
      )
      .catch(() => undefined)
  }
  const download = (id: string, inDialog: boolean) => {
    if (docHeld) return
    const found = docs.find((entry) => entry.item.id === id)
    const file = found ? mainFileOf(found.item) : null
    setDocProblem(null)
    if (inDialog) setDocDialog((current) => (current ? { ...current, downloading: true, problem: null } : current))
    else setDocBusy(id)
    documentBytes(api, id, 'download')
      .then(({ name, bytes }) => {
        saveBytes(name, bytes, file?.contentType ?? 'application/octet-stream')
        setOpened((current) => new Set(current).add(id))
      })
      .catch(() => {
        if (inDialog) setDocDialog((current) => (current ? { ...current, problem: t('documents.openFailed') } : current))
        else setDocProblem(t('documents.openFailed'))
      })
      .finally(() => {
        if (inDialog) setDocDialog((current) => (current ? { ...current, downloading: false } : current))
        else setDocBusy(null)
      })
  }
  const closeDocument = () => {
    dropPicture()
    setDocDialog(null)
    // Opened documents are no longer new: the list and the count follow.
    readDocuments()
    readHome()
  }

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
  useEffect(() => () => {
    dropFile()
    dropPicture()
  }, [])

  // ── the band ──
  const asOf = home.value?.asOf ?? null
  usePortalBand(
    homeBandOf({
      t,
      asOf: asOf ? formatTime(asOf, { locale }) : null,
      statement: seesPayments && seesPrices && !preview ? statementHref(locale) : null,
      emailSettings: !preview,
      ordersKey: built.orders && seesOrders,
      // B-W2b-194: New order (a buyer, the page built, not in a preview).
      newOrder: can('portal.orderRequests.manage') && pageBuilt('orders.new') && !preview ? `${prefix}/orders/new` : null,
    }),
  )

  // ── the model ──
  const openTasks = tasks.model.groups.reduce((sum, group) => sum + group.rows.filter((row) => !row.done).length, 0)
  const counts = orderCounts(orders.value)
  const first = isFirstVisit({ tasks: tasks.model.state, openTasks, seesOrders, ordersAll: seesOrders ? (orders.state === 'ready' ? counts.all : null) : 0, newDocuments: seesDocuments ? (documents.value?.items.length ?? null) : 0 })
  const buyer = can('portal.orderRequests.manage')
  const newOrderHref = buyer && pageBuilt('orders.new') ? `${prefix}/orders/new` : null
  const tileDefs = tilesFor(built, can)
  const queue = approvalIds(tasks.model.groups)

  return (
    <CustomerHomeView
      model={{
        prefix,
        search: can('portal.search') ? { ...search, recent } : null,
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
        documents: seesDocuments ? { state: documents.state, items: docs.map((entry) => entry.row), seeAllHref: built.documents ? `${prefix}/documents` : null, busy: docBusy, problem: docProblem, held: docHeld } : null,
        messages: seesMessages ? { state: messages.state, items: (messages.value ?? []).map((conversation) => ({ ...conversation, href: replyHref(prefix, conversation, (type, id) => recordPageOf(frame.kinds, type, id)) })) } : null,
        slow,
        approve: approve
          ? {
              ...approve,
              held: approveHeld(approve.page, approve.answer === 'busy'),
              position: approve.queue.length > 1 && approve.queue.includes(approve.requestId) ? { index: approve.queue.indexOf(approve.requestId) + 1, count: approve.queue.length } : null,
            }
          : null,
        document: docDialog
          ? {
              ...docDialog,
              row: { ...docDialog.row, isNew: false },
              problem: docDialog.problem ?? (docHeld && docDialog.downloading ? docHeld : null),
              position: docDialog.ids.length > 1 ? { index: docDialog.ids.indexOf(docDialog.row.id) + 1, count: docDialog.ids.length } : null,
            }
          : null,
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
        },
        onWhy,
        onPreview: (id) => openDocument(id, docs.map((entry) => entry.item.id)),
        onDownload: (id) => download(id, false),
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
        document: {
          onClose: closeDocument,
          onRetry: () => docDialog && openDocument(docDialog.row.id, docDialog.ids),
          onDownload: () => docDialog && download(docDialog.row.id, true),
          onStep: (step) => {
            if (!docDialog) return
            const next = neighbourOf(docDialog.ids, docDialog.row.id, step)
            if (next) openDocument(next, docDialog.ids)
          },
        },
      }}
      tasks={
        <TasksView
          model={tasks.model}
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
