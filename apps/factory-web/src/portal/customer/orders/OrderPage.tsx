'use client'

import { createElement, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { failureWords } from '@nexus/factory-domain/payments/online/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { readFromStore, storeUrl } from '../../../record-panels/store'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import {
  answerApproval,
  askRequest,
  confirmFake,
  fetchApproval,
  fetchDocuments,
  fetchIntent,
  fetchOpenItems,
  fetchOrder,
  fetchProgress,
  fetchRequests,
  fetchRules,
  fetchShipments,
  findRevision,
  // B-W2b-170
  makeTrackingLink,
  openDocument,
  startDepositPayment,
  withdrawRequest,
  type ApprovalPage,
  type ChangeRequest,
  type ChangeRules,
  type DocumentsRead,
  type FakeScenario,
  type OpenItems,
  type OrderRecord,
  type PaymentIntent,
  type ShipmentsRead,
} from './api'
import { orderBandOf } from './band'
import { openLater, saveBytes, useOffline } from './hooks'
import {
  askRefusal,
  cancelBodyOf,
  cancelHeld,
  cancellableLines,
  changeBodyOf,
  changedCells,
  changeHeld,
  confirmationFileOf,
  EMPTY_CANCEL,
  EMPTY_CHANGE,
  isFinal,
  movesOf,
  NAV_KEY,
  neighbourOf,
  NS,
  openDeposits,
  payHeld,
  paymentStateOf,
  POLL_MS,
  reconfirmHeld,
  reconfirmProblem,
  recordHref,
  shipToLines,
  tabOf,
  type CancelDraft,
  type ChangeDraft,
  type ReconfirmDecision,
} from './model'
import { Closed } from './OrdersPage'
import { OrderRecordView, type OrderDialog, type OrderRecordViewModel } from './view/OrderRecordView'
import { useOrderWords } from './words'
// B-W2b-374: the lines' options and artwork.
import { PortalLineOptions } from './options/PortalLineOptions'

/**
 * `/p/<party>/orders/<id>?tab=status|lines|shipments|documents|messages&line=` for a customer (B-W2b-191; design
 * portal.customer.orders rec "Order"): reads the order (GET /portal/sales-orders/:id) and each part on its own — the
 * revised version that waits (B-W2b-184), progress while shared (polled every `refreshSeconds`), the change and cancel
 * requests and their rules (B-W2b-183), shipments, documents (B-W2b-178), the deposit's open item (B-W2b-185) — fills the
 * band, runs the pop-ups (each write one Idempotency-Key per body), guards a typed change, reads again on the live
 * channel's hints, and walks to the previous / next order of the list with J / K.
 */
export function CustomerOrderPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <OrderRoute id={id} />
      </Suspense>
    </WithMessages>
  )
}

function OrderRoute({ id }: { id: string }) {
  const frame = usePortalFrame()
  const { t } = useOrderWords()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.salesOrders.view')
  return allowed ? <OrderContainer id={id} /> : <Closed title={t('list.title')} />
}

type ChangeState = { kind: 'change'; draft: ChangeDraft; busy: boolean; problem: string | null; discard: boolean }
type CancelState = { kind: 'cancel'; draft: CancelDraft; busy: boolean; problem: string | null }
type ReconfirmState = { kind: 'reconfirm'; state: 'loading' | 'error' | 'ready'; page: ApprovalPage | null; decision: ReconfirmDecision | null; comment: string; busy: boolean; problem: string | null; done: { decision: ReconfirmDecision; name: string; at: string } | null }
type PayState = { kind: 'pay'; depositId: string; method: 'CARD' | 'SEPA_DEBIT' | null; phase: 'idle' | 'starting' | 'ready' | 'paying'; secret: string | null; intent: PaymentIntent | null; problem: string | null }
type PreviewState = { kind: 'preview'; fileId: string; title: string; state: 'loading' | 'error' | 'ready'; bytes: Uint8Array | null }
type DialogState = ChangeState | CancelState | ReconfirmState | PayState | PreviewState | null

type Part<T> = { state: 'loading' | 'error' | 'ready'; read: T | null }
const loading = <T,>(): Part<T> => ({ state: 'loading', read: null })

function OrderContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderWords()
  const { t, locale } = words
  const offline = useOffline()
  const tab = tabOf(search?.get('tab'))
  const lineParam = search?.get('line') ?? null
  const can = (permission: string) => frame.me.permissions.includes(permission)
  const preview = frame.me.preview
  const mayAsk = can('portal.salesOrders.ask')
  const mayApprove = can('portal.approve') || (frame.access ? frame.access.capabilities.includes('portal.approve') : false)
  const readsApprovals = can('portal.approvals.view')
  const readsDocuments = can('portal.customerDocuments.view')
  const readsPayments = can('portal.payments.view')
  const paysHere = can('portal.payments.pay')

  const [record, setRecord] = useState<OrderRecord | null>(null)
  const [state, setState] = useState<OrderRecordViewModel['state'] | 'forbidden'>('loading')
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState<OrderRecordViewModel['revision']>({ state: 'loading', page: null })
  const [progress, setProgress] = useState<OrderRecordViewModel['progress']>({ state: 'loading', read: null })
  const [requests, setRequests] = useState<OrderRecordViewModel['requests']>({ state: 'loading', items: [] })
  const [rules, setRules] = useState<Part<ChangeRules>>(loading())
  const [shipments, setShipments] = useState<Part<ShipmentsRead>>(loading())
  const [documents, setDocuments] = useState<OrderRecordViewModel['documents']>({ state: readsDocuments ? 'loading' : 'noAccess', read: null })
  const [openItems, setOpenItems] = useState<OpenItems | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [notice, setNotice] = useState<OrderRecordViewModel['notice']>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [openLine, setOpenLine] = useState<string | null>(lineParam)
  const writeKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    return writeKey.current.key
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const next = await fetchOrder(api, id)
      setRecord(next)
      setLoadedAt(next.asOf)
      setState('ready')
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setState('missing')
      else if (isApiError(error) && error.kind === 'forbidden') setState('forbidden')
      else setState('error')
    }
  }, [api, id])

  const loadRevision = useCallback(async (number: string) => {
    if (!readsApprovals) return setRevision({ state: 'noAccess', page: null })
    try {
      setRevision({ state: 'ready', page: await findRevision(api, number) })
    } catch (error) {
      setRevision({ state: isApiError(error) && error.kind === 'forbidden' ? 'noAccess' : 'error', page: null })
    }
  }, [api, readsApprovals])

  const loadProgress = useCallback(async () => {
    try {
      setProgress({ state: 'ready', read: await fetchProgress(api, id) })
    } catch (error) {
      // Not shared (C1): no section, no hint.
      setProgress((current) => (isApiError(error) && error.kind === 'not_found' ? { state: 'hidden', read: null } : { state: 'error', read: current.read }))
    }
  }, [api, id])

  const loadRequests = useCallback(async () => {
    try {
      setRequests({ state: 'ready', items: (await fetchRequests(api, id)).items })
    } catch (error) {
      setRequests({ state: isApiError(error) && error.kind === 'forbidden' ? 'noAccess' : 'error', items: [] })
    }
  }, [api, id])

  const loadRules = useCallback(async () => {
    if (!mayAsk) return
    setRules((current) => ({ state: current.read ? 'ready' : 'loading', read: current.read }))
    try {
      setRules({ state: 'ready', read: await fetchRules(api, id) })
    } catch {
      setRules((current) => ({ state: 'error', read: current.read }))
    }
  }, [api, id, mayAsk])

  const loadShipments = useCallback(async () => {
    try {
      setShipments({ state: 'ready', read: await fetchShipments(api, id) })
    } catch {
      setShipments((current) => ({ state: 'error', read: current.read }))
    }
  }, [api, id])

  const loadDocuments = useCallback(async (): Promise<DocumentsRead | null> => {
    if (!readsDocuments) return null
    try {
      const read = await fetchDocuments(api, id)
      setDocuments({ state: 'ready', read })
      return read
    } catch (error) {
      setDocuments({ state: isApiError(error) && error.kind === 'forbidden' ? 'noAccess' : 'error', read: null })
      return null
    }
  }, [api, id, readsDocuments])

  const loadOpenItems = useCallback(async () => {
    if (!readsPayments) return
    try {
      setOpenItems(await fetchOpenItems(api))
    } catch {
      setOpenItems(null)
    }
  }, [api, readsPayments])

  useEffect(() => {
    void load()
    void loadRequests()
    void loadRules()
  }, [load, loadRequests, loadRules])

  const number = record?.order.number ?? null
  const reconfirmNeeded = record?.order.reconfirmNeeded ?? false
  useEffect(() => {
    if (number && reconfirmNeeded) void loadRevision(number)
  }, [number, reconfirmNeeded, loadRevision])

  const shared = record?.progressShared ?? false
  useEffect(() => {
    if (!shared) return
    void loadProgress()
  }, [shared, loadProgress])
  // Progress counts refresh at most once a minute (the API's `refreshSeconds`).
  const refreshSeconds = progress.read?.refreshSeconds ?? null
  useEffect(() => {
    if (!shared || !refreshSeconds) return
    const timer = setInterval(() => void loadProgress(), refreshSeconds * 1000)
    return () => clearInterval(timer)
  }, [shared, refreshSeconds, loadProgress])

  const hasOpenDeposit = (record?.deposits ?? []).some((deposit) => deposit.status === 'OPEN')
  useEffect(() => {
    if (hasOpenDeposit) void loadOpenItems()
  }, [hasOpenDeposit, loadOpenItems])

  useEffect(() => {
    if (tab === 'shipments') void loadShipments()
    if (tab === 'documents') void loadDocuments()
  }, [tab, loadShipments, loadDocuments])

  useEffect(() => setOpenLine(lineParam), [lineParam])
  useEffect(() => {
    if (tab !== 'lines' || !openLine) return
    const element = document.getElementById(`line-${openLine}`)
    element?.scrollIntoView({ block: 'center' })
  }, [tab, openLine])

  // A hint on the live channel (the bell's news of an order confirmed, a promise moved, a shipment shipped, an answer): read again.
  usePortalLive({
    onChange: (change) => {
      if (!record?.live.events.includes(change.type) && change.type !== 'partner_notification.created' && change.type !== 'partner_task.changed') return
      void load()
      void loadRequests()
      void loadRules()
      if (tab === 'shipments') void loadShipments()
      if (tab === 'documents') void loadDocuments()
    },
    onReconnect: () => void load(),
  })

  // ── J / K: the previous / next order of the list the person came from ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'j' && event.key !== 'k') || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="dialog"], [role="menu"], .ag-root'))) return
      let ids: string[] = []
      try {
        ids = JSON.parse(window.sessionStorage.getItem(NAV_KEY) ?? '[]') as string[]
      } catch {
        ids = []
      }
      const next = neighbourOf(ids, id, event.key === 'j' ? 1 : -1)
      if (!next) return
      event.preventDefault()
      router.push(recordHref(frame.prefix, next, tab))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, tab, frame.prefix, router])

  // ── what the band and the parts may do now ──────────────────────────────────────────────────────────────────────────
  const facts = { mayAsk: mayAsk && !preview, preview, offline, busy: false }
  const askHeldWords = (verdict: { possible: boolean; words: { it: string; en: string } } | null, extraPossible = false): string | null => {
    if (preview) return t('held.preview')
    if (!mayAsk) return t('held.mayAsk')
    if (verdict && !verdict.possible && !extraPossible) return verdict.words[locale]
    if (offline) return t('held.offline')
    return null
  }
  const changeHeldWords = askHeldWords(rules.read?.change ?? null)
  const cancelHeldWords = askHeldWords(rules.read?.cancel ?? null, rules.read ? cancellableLines(rules.read).length > 0 : false)
  const reconfirmHeldKey = reconfirmHeld(revision.page, { preview, mayApprove, offline })
  const revisionShown = reconfirmNeeded && revision.state === 'ready' && revision.page?.content.revisedOrder ? revision.page.content.revisedOrder.revision : null
  const pay = useMemo(() => {
    const out: Record<string, { held: string | null }> = {}
    if (!record || !readsPayments || !openItems) return out
    for (const deposit of openDeposits(record.deposits)) {
      const item = openItems.deposits.find((entry) => entry.depositRequestId === deposit.id)
      if (!item) continue
      const held = payHeld({ preview, mayPay: openItems.mayPay && paysHere, cardAvailable: openItems.card.available, canPay: item.canPay, offline })
      out[deposit.id] = { held: held ? t(held) : null }
    }
    return out
  }, [record, readsPayments, openItems, preview, offline, t, paysHere])
  const firstPay = Object.entries(pay)[0] ?? null
  const fileHeld = preview ? t('held.previewFiles') : offline ? t('held.offline') : null

  // ── the pop-ups ────────────────────────────────────────────────────────────────────────────────────────────────────
  const openChange = (focusLine: string | null = null) => {
    writeKey.current = null
    setDialog({ kind: 'change', draft: { ...EMPTY_CHANGE, focusLine }, busy: false, problem: null, discard: false })
    void loadRules()
  }
  const openCancel = () => {
    writeKey.current = null
    setDialog({ kind: 'cancel', draft: { ...EMPTY_CANCEL, scope: rules.read && !rules.read.cancel.possible && cancellableLines(rules.read).length > 0 ? 'LINES' : 'ORDER' }, busy: false, problem: null })
    void loadRules()
  }
  const openReconfirm = async () => {
    const requestId = revision.page?.request.id
    if (!requestId) return
    writeKey.current = null
    setDialog({ kind: 'reconfirm', state: 'loading', page: revision.page, decision: null, comment: '', busy: false, problem: null, done: null })
    try {
      const page = await fetchApproval(api, requestId)
      setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, state: 'ready', page } : current))
    } catch {
      setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, state: 'error' } : current))
    }
  }
  const openPay = (depositId: string) => {
    const methods = openItems?.card.methods ?? []
    writeKey.current = null
    setDialog({ kind: 'pay', depositId, method: methods[0] ?? null, phase: 'idle', secret: null, intent: null, problem: null })
  }

  const changeDirty = dialog?.kind === 'change' && rules.read ? changedCells(rules.read, dialog.draft).length > 0 || dialog.draft.requestedDate !== '' || dialog.draft.shipToAddressId !== '' || dialog.draft.note.trim() !== '' : false
  usePortalUnsaved(`order-change:${id}`, { dirty: changeDirty, what: t('unsaved.change') })

  const sent = (key: string) => {
    setDialog(null)
    setNotice({ tone: 'success', key })
    writeKey.current = null
    void loadRequests()
    void loadRules()
    void load()
    frame.refreshTasks()
  }

  const sendChange = () => {
    if (dialog?.kind !== 'change' || !rules.read || dialog.busy) return
    if (changeHeld(rules.read, dialog.draft, { ...facts, busy: dialog.busy })) return
    const body = changeBodyOf(rules.read, dialog.draft)
    setDialog({ ...dialog, busy: true, problem: null })
    askRequest(api, id, body, keyFor(body))
      .then(() => sent('notice.changeSent'))
      .catch((error: unknown) => {
        const refusal = askRefusal(error)
        setDialog((current) => (current?.kind === 'change' ? { ...current, busy: false, problem: refusal.key, draft: refusal.reread ? { ...current.draft, step: 'edit' } : current.draft } : current))
        if (refusal.reread) void loadRules()
      })
  }

  const sendCancel = () => {
    if (dialog?.kind !== 'cancel' || !rules.read || dialog.busy) return
    const held = cancelHeld(rules.read, dialog.draft, { ...facts, busy: dialog.busy })
    if (held) {
      setDialog({ ...dialog, draft: { ...dialog.draft, tried: true } })
      return
    }
    const body = cancelBodyOf(rules.read, dialog.draft)
    setDialog({ ...dialog, busy: true, problem: null })
    askRequest(api, id, body, keyFor(body))
      .then(() => sent('notice.cancelSent'))
      .catch((error: unknown) => {
        const refusal = askRefusal(error)
        setDialog((current) => (current?.kind === 'cancel' ? { ...current, busy: false, problem: refusal.key } : current))
        if (refusal.reread) void loadRules()
      })
  }

  const withdraw = (request: ChangeRequest) => {
    withdrawRequest(api, id, request.id, request.version)
      .then(() => {
        setNotice({ tone: 'info', key: 'notice.withdrawn' })
        void loadRequests()
        void loadRules()
      })
      .catch((error: unknown) => setNotice({ tone: 'danger', key: askRefusal(error).key }))
  }

  const sign = (name: string) => {
    if (dialog?.kind !== 'reconfirm' || !dialog.page || dialog.busy) return
    const problem = reconfirmProblem(dialog.decision, dialog.comment)
    if (problem) return setDialog({ ...dialog, problem })
    const body = { decision: dialog.decision!, answer: dialog.comment.trim() || null, typedName: name.trim(), version: dialog.page.request.version }
    setDialog({ ...dialog, busy: true, problem: null })
    answerApproval(api, dialog.page.request.id, body, keyFor(body))
      .then((page) => {
        setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, busy: false, page, done: { decision: body.decision, name: body.typedName, at: page.request.answer?.at ?? new Date().toISOString() } } : current))
        writeKey.current = null
        frame.refreshTasks()
        void load()
      })
      .catch((error: unknown) => {
        const key = !isApiError(error)
          ? 'problem.internal'
          : error.kind === 'invalid' && error.issues.some((issue) => /typedName/.test(issuePath(issue)))
            ? 'reconfirm.problem.name'
            : error.kind === 'conflict'
              ? 'reconfirm.problem.changed'
              : error.kind === 'forbidden'
                ? 'problem.forbidden'
                : askRefusal(error).key
        setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, busy: false, problem: key } : current))
      })
  }

  // The deposit: start at the provider, the FAKE provider's fields, then the page asks until the provider decided.
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (polling.current ? clearTimeout(polling.current) : undefined), [])
  const poll = useCallback(
    (intentId: string) => {
      if (polling.current) clearTimeout(polling.current)
      polling.current = setTimeout(async () => {
        try {
          const intent = await fetchIntent(api, intentId)
          let keep = true
          setDialog((current) => {
            if (current?.kind !== 'pay' || current.intent?.id !== intentId) {
              keep = false
              return current
            }
            return { ...current, intent }
          })
          if (isFinal(intent)) {
            if (intent.status === 'SUCCEEDED') {
              void load()
              void loadOpenItems()
            }
          } else if (keep) poll(intentId)
        } catch {
          poll(intentId)
        }
      }, POLL_MS)
    },
    [api, load, loadOpenItems],
  )

  const startPay = () => {
    if (dialog?.kind !== 'pay' || !dialog.method) return
    const body = { depositRequestId: dialog.depositId, method: dialog.method }
    setDialog({ ...dialog, phase: 'starting', problem: null, intent: null })
    startDepositPayment(api, body.depositRequestId, body.method, keyFor(body))
      .then((started) => {
        setDialog((current) => (current?.kind === 'pay' ? { ...current, phase: 'ready', secret: started.provider?.clientSecret ?? null, intent: started.intent } : current))
        if (started.intent.status === 'WAITING' && !started.provider) poll(started.intent.id)
      })
      .catch((error: unknown) => {
        const code = isApiError(error) ? error.issues.map((issue) => issuePath(issue).split(/[/.]/).pop() ?? '').find((last) => /^[A-Z_]+$/.test(last)) : null
        setDialog((current) => (current?.kind === 'pay' ? { ...current, phase: 'idle', problem: code ? `pay.problem.${code}` : askRefusal(error).key } : current))
      })
  }

  const scenario = (which: FakeScenario) => {
    if (dialog?.kind !== 'pay' || !dialog.secret || !dialog.intent) return
    const intentId = dialog.intent.id
    setDialog({ ...dialog, phase: 'paying' })
    confirmFake(api, dialog.secret, which)
      .then((answer) => {
        // 3-D Secure asked: the provider's window would open; its fields stay to approve or fail it.
        if (answer.state === 'requires_action') setDialog((current) => (current?.kind === 'pay' ? { ...current, phase: 'ready' } : current))
        poll(intentId)
      })
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'pay' ? { ...current, phase: 'ready', problem: askRefusal(error).key } : current)))
  }

  const download = (file: { fileId: string; name: string }) => {
    openDocument(api, file.fileId, 'download')
      .then((link) => readFromStore({ method: 'GET', url: link.url, headers: link.headers, expiresAt: link.expiresAt }))
      .then((bytes) => saveBytes(file.name, bytes))
      .catch((error: unknown) => setNotice({ tone: 'danger', key: isApiError(error) && error.kind === 'conflict' ? 'docs.withdrawn' : 'docs.downloadFailed' }))
  }

  const previewFile = (file: { fileId: string; title: string }) => {
    setDialog({ kind: 'preview', fileId: file.fileId, title: file.title, state: 'loading', bytes: null })
    openDocument(api, file.fileId, 'preview')
      .then((link) => readFromStore({ method: 'GET', url: link.url, headers: link.headers, expiresAt: link.expiresAt }))
      .then((bytes) => setDialog((current) => (current?.kind === 'preview' && current.fileId === file.fileId ? { ...current, state: 'ready', bytes } : current)))
      .catch(() => setDialog((current) => (current?.kind === 'preview' && current.fileId === file.fileId ? { ...current, state: 'error' } : current)))
  }

  const openConfirmation = async () => {
    const tab = openLater()
    const read = documents.read ?? (await loadDocuments())
    const fileId = read ? confirmationFileOf(read.items) : null
    if (!fileId) {
      tab.fail()
      return setNotice({ tone: 'info', key: 'docs.noConfirmation' })
    }
    try {
      const link = await openDocument(api, fileId, 'preview')
      if (Object.keys(link.headers).length === 0) tab.go(storeUrl(link.url))
      else {
        tab.fail()
        previewFile({ fileId, title: t('docs.confirmation') })
      }
    } catch {
      tab.fail()
      setNotice({ tone: 'danger', key: 'docs.downloadFailed' })
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied((current) => (current === text ? null : current)), 2000)
    })
  }

  // B-W2b-170: "Copy tracking link" — a new link to the shipment's branded tracking page (its address in this answer only).
  const linkHeld = preview ? t('shipments.copyLinkPreview') : offline ? t('held.offline') : null
  const copyTrackingLink = (shipmentId: string) => {
    if (linkHeld) return
    makeTrackingLink(api, id, shipmentId, newIdempotencyKey())
      .then((made) => {
        if (!made.url) throw new Error('no link')
        const url = made.url
        return navigator.clipboard?.writeText(url).then(() => {
          setCopied(`link:${shipmentId}`)
          setTimeout(() => setCopied((current) => (current === `link:${shipmentId}` ? null : current)), 2000)
        })
      })
      .catch((error: unknown) => setNotice({ tone: 'danger', key: isApiError(error) && error.kind === 'conflict' ? 'shipments.copyLinkTooMany' : 'shipments.copyLinkFailed' }))
  }

  // ── the band ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const ready = state === 'ready' && record
  usePortalBand(
    ready
      ? orderBandOf({
          words,
          record,
          tab,
          prefix: frame.prefix,
          facts: {
            changeHeld: changeHeldWords,
            cancelHeld: cancelHeldWords,
            reconfirm: revisionShown !== null ? { revision: revisionShown, held: reconfirmHeldKey ? t(reconfirmHeldKey) : null } : null,
            shipments: record.shipments.shown,
            moves: movesOf(record.promiseHistory),
            confirmation: readsDocuments,
            pay: firstPay ? { held: firstPay[1].held } : null,
          },
          onChange: () => openChange(),
          onCancel: openCancel,
          onReconfirm: () => void openReconfirm(),
          onHistory: () => {
            if (tab !== 'status') router.push(recordHref(frame.prefix, id, 'status'))
            setHistoryOpen(true)
          },
          onConfirmation: () => void openConfirmation(),
          onPay: () => (firstPay ? openPay(firstPay[0]) : undefined),
        })
      : { title: state === 'missing' ? t('record.missing') : t('list.title'), back: { href: `${frame.prefix}/orders`, label: t('list.title') } },
  )

  if (state === 'forbidden') return <Closed title={t('list.title')} />

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const dialogModel: OrderDialog | null = !record || !dialog
    ? null
    : dialog.kind === 'change'
      ? {
          kind: 'change',
          model: {
            state: rules.read ? 'ready' : rules.state === 'error' ? 'error' : 'loading',
            number: record.order.number,
            rules: rules.read,
            draft: dialog.draft,
            held: changeHeld(rules.read, dialog.draft, { ...facts, busy: dialog.busy }),
            busy: dialog.busy,
            problem: dialog.problem,
            discard: dialog.discard,
            shipTo: shipToLines(record.order.shipTo),
            today,
          },
        }
      : dialog.kind === 'cancel'
        ? { kind: 'cancel', model: { state: rules.read ? 'ready' : rules.state === 'error' ? 'error' : 'loading', number: record.order.number, rules: rules.read, draft: dialog.draft, held: cancelHeld(rules.read, dialog.draft, { ...facts, busy: dialog.busy }), busy: dialog.busy, problem: dialog.problem } }
        : dialog.kind === 'reconfirm'
          ? {
              kind: 'reconfirm',
              model: { state: dialog.state, page: dialog.page, number: record.order.number, decision: dialog.decision, comment: dialog.comment, held: dialog.done ? null : reconfirmHeld(dialog.page, { preview, mayApprove, offline }), problem: dialog.problem, busy: dialog.busy, done: dialog.done },
            }
          : dialog.kind === 'pay'
            ? (() => {
                const deposit = record.deposits.find((entry) => entry.id === dialog.depositId)
                const item = openItems?.deposits.find((entry) => entry.depositRequestId === dialog.depositId)
                const held = pay[dialog.depositId]?.held ?? null
                const failure = dialog.intent?.status === 'FAILED' ? failureWords(dialog.intent.failureCode, locale) : dialog.intent?.status === 'CANCELLED' ? t('pay.cancelled') : null
                return {
                  kind: 'pay' as const,
                  model: {
                    amount: words.money(item?.open ?? deposit?.amount ?? null, deposit?.currency ?? record.order.currency),
                    number: record.order.number,
                    methods: openItems?.card.methods ?? [],
                    method: dialog.method,
                    state: paymentStateOf(dialog.phase, dialog.intent),
                    fake: openItems?.card.mode === 'FAKE' || openItems?.card.provider === 'PAYMENT_FAKE',
                    held: dialog.phase === 'idle' && !dialog.intent ? held : null,
                    failure,
                    problem: dialog.problem,
                  },
                }
              })()
            : { kind: 'preview', model: { title: dialog.title, state: dialog.state, bytes: dialog.bytes } }

  return (
    <OrderRecordView
      model={{
        state,
        record,
        tab,
        prefix: frame.prefix,
        // B-W2b-194: a line's ⋯ "Reorder this line" opens New order's reorder of this order.
        reorderHref: frame.me.permissions.includes('portal.orderRequests.manage') && !preview ? `${frame.prefix}/orders/new?reorder=${encodeURIComponent(id)}` : null,
        offlineSince: offline ? loadedAt : null,
        notice,
        revision,
        reconfirmHeld: reconfirmHeldKey ? t(reconfirmHeldKey) : null,
        progress: shared ? progress : { state: 'hidden', read: null },
        requests,
        withdrawHeld: preview ? t('held.preview') : !mayAsk ? t('held.mayAsk') : offline ? t('held.offline') : null,
        changeHeld: changeHeldWords,
        pay,
        shipments,
        documents,
        fileHeld,
        // B-W2b-374 (XF3:04): the lines' options and the artwork the office shows here.
        options: record ? createElement(PortalLineOptions, { api, orderId: id, fileHeld, refreshKey: loadedAt ?? '' }) : null,
        openLine,
        copied,
        // B-W2b-170
        linkHeld,
        historyOpen,
        dialog: dialogModel,
      }}
      actions={{
        onRetry: () => {
          setState('loading')
          void load()
        },
        onRetryRevision: () => (number ? void loadRevision(number) : undefined),
        onRetryProgress: () => void loadProgress(),
        onRetryRequests: () => void loadRequests(),
        onRetryShipments: () => {
          setShipments(loading())
          void loadShipments()
        },
        onRetryDocuments: () => {
          setDocuments({ state: 'loading', read: null })
          void loadDocuments()
        },
        onReconfirm: () => void openReconfirm(),
        onPay: openPay,
        onWithdraw: withdraw,
        onChangeLine: (lineId) => openChange(lineId),
        onLine: (lineId) => setOpenLine(lineId),
        onHistory: setHistoryOpen,
        onCopy: copy,
        // B-W2b-170
        onCopyTrackingLink: copyTrackingLink,
        onPreview: previewFile,
        onDownload: download,
        onDismissNotice: () => setNotice(null),
        dialog: {
          change: {
            onCells: (lineId, sizes) => setDialog((current) => (current?.kind === 'change' ? { ...current, problem: null, draft: { ...current.draft, cells: { ...current.draft.cells, [lineId]: sizes } } } : current)),
            onDate: (day) => setDialog((current) => (current?.kind === 'change' ? { ...current, draft: { ...current.draft, requestedDate: day } } : current)),
            onShipTo: (addressId) => setDialog((current) => (current?.kind === 'change' ? { ...current, draft: { ...current.draft, shipToAddressId: addressId } } : current)),
            onNote: (note) => setDialog((current) => (current?.kind === 'change' ? { ...current, draft: { ...current.draft, note } } : current)),
            onReview: () => setDialog((current) => (current?.kind === 'change' && rules.read && !changeHeld(rules.read, current.draft, facts) ? { ...current, problem: null, draft: { ...current.draft, step: 'review' } } : current)),
            onBack: () => setDialog((current) => (current?.kind === 'change' ? { ...current, draft: { ...current.draft, step: 'edit' } } : current)),
            onSend: sendChange,
            onClose: () => setDialog((current) => (current?.kind === 'change' && !current.busy ? (changeDirty ? { ...current, discard: true } : null) : current)),
            onDiscard: () => setDialog(null),
            onStay: () => setDialog((current) => (current?.kind === 'change' ? { ...current, discard: false } : current)),
            onRetry: () => void loadRules(),
          },
          cancel: {
            onDraft: (draft) => setDialog((current) => (current?.kind === 'cancel' ? { ...current, draft, problem: null } : current)),
            onSend: sendCancel,
            onClose: () => setDialog((current) => (current?.kind === 'cancel' && current.busy ? current : null)),
            onRetry: () => void loadRules(),
          },
          reconfirm: {
            onDecision: (decision) => setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, decision, problem: null } : current)),
            onComment: (comment) => setDialog((current) => (current?.kind === 'reconfirm' ? { ...current, comment } : current)),
            onSign: sign,
            onClose: () => {
              setDialog((current) => (current?.kind === 'reconfirm' && current.busy ? current : null))
              if (number) void loadRevision(number)
            },
            onRetry: () => void openReconfirm(),
          },
          pay: {
            onMethod: (method) => setDialog((current) => (current?.kind === 'pay' ? { ...current, method } : current)),
            onStart: startPay,
            onScenario: scenario,
            onRetry: () => setDialog((current) => (current?.kind === 'pay' ? { ...current, phase: 'idle', intent: null, secret: null, problem: null } : current)),
            onClose: () => {
              if (polling.current) clearTimeout(polling.current)
              setDialog((current) => (current?.kind === 'pay' && current.phase === 'starting' ? current : null))
            },
          },
          preview: {
            onClose: () => setDialog(null),
            onRetry: () => (dialog?.kind === 'preview' ? previewFile({ fileId: dialog.fileId, title: dialog.title }) : undefined),
            onDownload: () => (dialog?.kind === 'preview' ? download({ fileId: dialog.fileId, name: `${dialog.title}.pdf` }) : undefined),
          },
        },
      }}
    >
      {tab === 'messages' && record ? <PortalThread type="SalesOrder" id={record.order.id} showRecord={false} /> : null}
    </OrderRecordView>
  )
}
