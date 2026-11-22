'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOrderMargin } from './margin/use-margin'
import { WithMessages } from '../../../../record-panels/i18n'
import { ThreadPrint } from '../../../_shared/record-thread/ThreadPrint'
import { RecordCustomFields } from '../../../../record-panels/custom-fields/RecordCustomFields' // B-TH-280
import { getStyle, listVersions, type StyleDetail, type VersionsAnswer } from '../../quotes/api'
import {
  getSchedule,
  listAmendments,
  getOrder,
  getSdi,
  getSettlement,
  listCancelReasons,
  listOrderWorkOrders,
  type AmendmentsAnswer,
  type CancelReason,
  type Order,
  type Schedule,
  type OrderWorkOrder,
  type SdiStatus,
  type Settlement,
} from '../api'
import { isStepUpCancelled, useLive, useStepUp } from '../hooks'
import { olderRead } from '../../../../lib/records/older-read' // fx-11: a read older than the record held is dropped
import { abilitiesOf, landingOf, readProblem, romeToday, writeProblem } from '../model'
import { readOnlyOnPage } from '../model' // F-OO-211: the custom fields' read-only reader (the view's own rule)
// F-SA-239: the page live part by part (the read's own watch list, one coalesce table, stale tabs, typed work kept).
import { changedBy, EMPTY_QUEUE, enqueue, nextDue, opened, ORDER_PARTS, partsOf, take, watchedIds, type LiveQueue, type OrderPagePart } from './live'
import { PART_LOADING, type Loaded, type OrderRecordModel, type Part, type RecordActsBase, type RecordDialog } from './record-model'
import { OrderRecordView } from './view/OrderRecordView'
// ---- F-OP-134 (N-5): one acts hook per tab — the container mounts them and hands the view what they return as plain props ----
import { useBandActs } from './use-band-acts'
import { useOverviewActs } from './use-overview-acts'
import { useLinesActs } from './use-lines-acts'
import { useProductionActs } from './use-production-acts'
import { useShipmentsActs } from './use-shipments-acts'
import { useMoneyActs } from './use-money-acts'
import { usePriceCheckCard } from './use-price-check-card' // F-CP-142: Money's Price check card
import { useLinesDraft } from './use-lines-draft' // F-OL-03: the Lines tab's draft, Review and save, two people
// ---- end F-OP-134
// ---- B-W2b-323 (orders in depth on screen) ----
import { useLocale } from '../../../../lib/i18n/provider'
import { useOrderDepth } from '../depth/use-order-depth'
import { NAMESPACE as DEPTH } from '../depth/model'
// B-W2b-340: the configurator of an order line (its "Options" dialog).
import { OrderLineOptions } from './configurator/OrderLineOptions'
// B-W2b-368 (XF1:02): "Waits for the factory review" with each unit's review.
import { useReviewBanner } from './review-banner/use-review-banner'
import { ReviewBanner } from './review-banner/view/ReviewBanner'
import { createElement } from 'react'
// B-W2b-380 (XF6:02): cost changed since priced, on the order's lines.
import { useCostChanged } from '../../_shared/cost-changed/use-cost-changed'
import { CostChangedMark } from '../../_shared/cost-changed/view/CostChangedMark'
// ---- B-TH-214: the docked thread on the order (RecordFrame; Activity's tools in its "⋯") ----
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
import { printHref } from '../../../../shell/print/print-model'
// B-TH-256: what points at the order (complaints, returns, planning's re-promises, the gates' refusals).
import { useOrderLinks } from './links/use-order-links'
// F-SA-230: the ⋯ menu's People — the production lane's dialogs' catalogues (the dialogs are use-band-acts').
import { SUPERVISOR_NS } from '../../../_shared/production-supervisor/model'
import { NOTES_NS } from '../../../production/_shared/notes/model'
import { useOrderProduction } from './overview/use-order-production' // F-SA-232: Overview's production read (the order's own pieces)
import { useOrderAsks } from './production/use-order-asks' // F-PT-103: the order's asks (the issues list)
import { healthViewOf } from './production/now' // F-PT-404: the health mark through the page's one read
import { useStyleSpecs } from './production/use-style-specs' // F-PT-401: the order's styles (What we make it to)
import { styleIdsOf } from './production/specs' // F-PT-401
import { useCustomerReceipt } from './production/use-customer-receipt' // F-PT-304: Record what the customer sent…
import { useAskBuyers } from './production/use-ask-buyers' // F-PT-304: Ask the buyers…
import { customerGoodsOf } from './production/materials' // F-PT-304
import { getReadiness, type ReadinessRow } from '../../../production/work-orders/daily/api' // F-SA-234: the work orders' materials
// F-SA-236: this order's customer requests and the approvals we asked it (Changes).
import { listOrderRequests, type BrandRequest } from '../../../home/approvals/requests/api'
import { readRecordRequests, type OfficeRequest } from '../../../../record-panels/approvals/api'
import { useOrderFiles } from '../../../_shared/record-thread/use-order-files' // F-SA-237: the order's files (one read, two places)
import type { OrderFilesHost } from '../../../_shared/record-thread/use-order-files' // F-OP-215
import { orderFileHrefOf } from '../../../_shared/record-thread/order-file-href' // F-OF-101: a block's door "Open on … ›"
import { OrderDock } from './dock/OrderDock' // F-SA-262: the dock's pick of ONE conversation
import { aboutPlace } from './dock/discuss' // F-SA-266: "Show on the page" — a message about a part of the order jumps back to its row
import { narrowNow, tabAddress } from '../../../_shared/record-frame/address' // F-OP-210: the in-page moves keep the dock's scope
import type { Work } from './overview/api' // F-SA-262
// F-SA-243: the order page is a door of the ONE review window (Home › Approvals' own), its "Decide for <customer>" too.
import { useRequestReviewDoor } from '../../../home/approvals/requests/use-request-review-door'
import { doorListOf } from '../../../home/approvals/requests/model'
import { CustomerOverrideProvider } from '../../../_shared/customer-override/CustomerOverride'
// F-SA-244: the conversation side of a change — the told lines of the order's changes, the cards' facts, Who was told.
import { askFactsOf, changeFactsOf, readToldChanges, type ToldChanges } from './told'
import { stillRowsOf } from './changes/model'
import { WhoWasToldDialog } from './WhoWasTold'

/**
 * `/w/<company>/sales/orders/<id>` (SCR-039): loads the order (orders.view; the API checks its company and customer),
 * and the parts its tabs show by the person's rights — its work orders with their floor progress (workorders.view), the
 * settlement and each issued invoice's SDI state (invoices.view), the quote's acceptance evidence (quotes.view) — and
 * does what the view asks, one write at a time, each with the order's version as read (a 409 reads it again and says
 * so): a new promise, ready by hand, close; the deposit's bank-details page, the payment (with the TD02: a fresh
 * authenticator code), the TD02's send to SDI. Live: events that name the order or a record of its chain read it again.
 * B-W2a-50: the payment schedule and the amendments (Changes tab) with it; "Amend order" holds the draft here (each style
 * read for its sizes and colourways; Review asks the API's preview, Apply sends the version as read); close and reopen
 * lines; the cancel's impact check when its dialog opens, then the cancel with the typed number; copy as a new quote.
 * F-OP-134 (N-5): each tab's acts live in their own container hook (use-band-acts, use-overview-acts, use-lines-acts,
 * use-production-acts, use-shipments-acts, use-money-acts); this container mounts them with the one write and the one dialog slot,
 * and hands the view what they return as plain props (a view never imports a hook that fetches).
 */
/** B-W2b-380: no lines yet (the order is read). */
const NO_LINES: readonly never[] = []

/** The catalogues the order's page loads (W1 browser repair: its tests draw the record with these, as the page does). */
export const RECORD_NAMESPACES = ['orders', 'sales', 'lists', 'records', DEPTH /* B-W2b-323 */, SUPERVISOR_NS, NOTES_NS /* F-SA-230 */, 'order-shipments' /* F-OS-101 (L11) */] as const

export function OrderRecord({ orderId }: { orderId: string }) {
  return (
    <WithMessages namespaces={RECORD_NAMESPACES}>
      <RecordContainer orderId={orderId} />
    </WithMessages>
  )
}

const part = <T,>(value: T): Part<T> => ({ value, problem: null })
const ISSUED = (status: string) => status !== 'DRAFT'

function RecordContainer({ orderId }: { orderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/orders\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  // F-SA-230: the tabs re-cut; an old address lands on its new tab and section (`?tab=margin` → Money #margin with the margin grain).
  const landing = landingOf(params?.get('tab'), can)
  const tab = landing.tab
  // F-OP-210: through tabAddress — an arrival: every term kept as it came (a scope, the narrow view, `new`, a message to open at).
  useEffect(() => {
    if (!landing.moved) return
    router.replace(tabAddress(pathname, window.location.search, landing.tab, { anchor: landing.anchor, arrival: true }), { scroll: false })
  }, [landing.moved, landing.tab, landing.anchor]) // eslint-disable-line react-hooks/exhaustive-deps

  const [order, setOrder] = useState<Loaded<Order>>({ status: 'loading' })
  const current = useRef<Order | null>(null)
  const [workOrders, setWorkOrders] = useState<Part<OrderWorkOrder[]> | null>(can.viewWorkOrders ? PART_LOADING : null)
  const [settlement, setSettlement] = useState<Part<Settlement> | null>(can.viewInvoices ? PART_LOADING : null)
  const [sdi, setSdi] = useState<Record<string, Part<SdiStatus>> | null>(can.viewInvoices ? {} : null)
  const [versions, setVersions] = useState<Part<VersionsAnswer> | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<OrderRecordModel['notice']>(null)
  const [dialogProblem, setDialogProblem] = useState<OrderRecordModel['dialogProblem']>(null)
  const [changed, setChanged] = useState<{ at: string; parts?: readonly string[]; by?: string | null } | null>(null)
  const [schedule, setSchedule] = useState<Part<Schedule> | null>(null)
  const [amendments, setAmendments] = useState<Part<AmendmentsAnswer> | null>(null)
  const [changeStyles, setChangeStyles] = useState<Record<string, StyleDetail | null | undefined>>({})
  // B-W2b-16: the CANCEL reasons (the code a close of lines names, and its words on a closed line).
  const [cancelReasons, setCancelReasons] = useState<CancelReason[] | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    listCancelReasons(api, abort.signal)
      .then(setCancelReasons)
      .catch(() => setCancelReasons(null))
    return () => abort.abort()
  }, [api])
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const loadParts = useCallback(
    (value: Order) => {
      if (can.viewWorkOrders)
        listOrderWorkOrders(api, value.id)
          .then((rows) => setWorkOrders(part(rows)))
          .catch((error: unknown) => setWorkOrders({ value: null, problem: readProblem(error) }))
      if (can.viewInvoices) {
        getSettlement(api, value.id)
          .then((answer) => setSettlement(part(answer)))
          .catch((error: unknown) => setSettlement({ value: null, problem: readProblem(error) }))
        const issued = value.chain.invoices.filter((invoice) => ISSUED(invoice.status))
        setSdi((known) => Object.fromEntries(issued.map((invoice) => [invoice.id, known?.[invoice.id] ?? PART_LOADING])))
        for (const invoice of issued) {
          getSdi(api, invoice.id)
            .then((answer) => setSdi((known) => ({ ...(known ?? {}), [invoice.id]: part(answer) })))
            .catch((error: unknown) => setSdi((known) => ({ ...(known ?? {}), [invoice.id]: { value: null, problem: readProblem(error) } })))
        }
      }
      if (can.viewQuotes && value.chain.quote) {
        setVersions((known) => known ?? PART_LOADING)
        listVersions(api, value.chain.quote.id)
          .then((answer) => setVersions(part(answer)))
          .catch((error: unknown) => setVersions({ value: null, problem: readProblem(error) }))
      }
      // B-W2a-50: the payment schedule and the amendments (none yet: nothing to read).
      setSchedule((known) => known ?? PART_LOADING)
      getSchedule(api, value.id)
        .then((answer) => setSchedule(part(answer)))
        .catch((error: unknown) => setSchedule({ value: null, problem: readProblem(error) }))
      // F-SA-236: the amendments (with their frozen snapshots) are read when "Before → after" opens, no longer on every read: Changes'
      // history comes from the ONE `…/changes` read (the depth's).
      setAmendments(null)
    },
    [api, can.viewWorkOrders, can.viewInvoices, can.viewQuotes],
  )

  // F-SA-236: the amendments' snapshots for "Before → after" (read when the dialog opens; a line the order no longer holds is named
  // by its style: those styles are read too).
  const readAmendments = useCallback(
    (value: Order) => {
      if (value.amendments.count === 0) return setAmendments(part({ orderId: value.id, number: value.number, reapprovalNeededAt: value.reapprovalNeededAt, amendments: [] }))
      setAmendments((known) => known ?? PART_LOADING)
      listAmendments(api, value.id)
        .then((answer) => {
          setAmendments(part(answer))
          const own = new Set(value.lines.map((line) => line.styleId))
          const missing = [...new Set(answer.amendments.flatMap((entry) => entry.diff.lines.map((line) => line.styleId)))].filter((styleId) => !own.has(styleId))
          for (const styleId of missing)
            getStyle(api, styleId)
              .then((style) => setChangeStyles((known) => ({ ...known, [styleId]: style })))
              .catch(() => setChangeStyles((known) => ({ ...known, [styleId]: null })))
        })
        .catch((error: unknown) => setAmendments({ value: null, problem: readProblem(error) }))
    },
    [api],
  )

  // fx-11 (end check): the page never goes back to an older version of its order (olderRead, as the purchase order since fx-10): a live
  // re-read that left before a write and answered after it would put the order as it was back, and the next write would send that
  // version and be refused as changed (409). Such a read is dropped: the write's own answer is newer, and its event reads it again.
  const setValue = useCallback((next: Order): boolean => {
    if (olderRead(current.current, next)) return false
    current.current = next
    setOrder({ status: 'ready', value: next })
    return true
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getOrder(api, orderId)
      if (!setValue(next)) return // fx-11: an older read than the page holds
      setChanged(null)
      loadParts(next)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setOrder({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setOrder({ status: 'forbidden' })
      else setOrder({ status: 'error', problem: readProblem(error) })
    }
  }, [api, orderId, setValue, loadParts])

  useEffect(() => {
    void load()
  }, [load])

  // ---- F-SA-239: live, part by part — an event re-reads only the parts the order read's own watch list names for it (and only when it
  // names one of the order's records), through ONE coalesce table (parts 700 ms; piece counts 3 s trailing, ≤ 1 read / 10 s); Money,
  // Shipments and Files only while they show (else stale, read when opened); under typed work the order waits for Reload.
  // B-TH-214: the tab's live state shows in the shell's band; F-SA-232: the stream's state for Overview's freshness line.
  const queueRef = useRef<LiveQueue>(EMPTY_QUEUE)
  const [queueTick, setQueueTick] = useState(0)
  const tabRef = useRef(tab)
  tabRef.current = tab
  const runPartsRef = useRef<(parts: readonly OrderPagePart[]) => void>(() => undefined)
  const toldSoonRef = useRef<() => void>(() => undefined) // F-SA-244
  const reconnectRef = useRef<() => void>(() => void load())
  // F-PT-402: the customer's tech pack hangs on the order's inquiry — its file events are the page's too (read again on Production).
  const packRef = useRef<{ readonly inquiryId: string | null; readonly again: () => void }>({ inquiryId: null, again: () => undefined })
  const liveState = useLive(
    (change) => {
      const value = current.current
      if (!value) return
      // F-SA-244: a new message on the order's conversation may be a change's line: its told lines are read again (a moment later).
      if (change.type === 'thread.message_posted' && change.fields.recordType === 'SalesOrder' && change.fields.recordId === value.id) toldSoonRef.current()
      const ids = watchedIds(value, value.live)
      if (packRef.current.inquiryId) ids.add(packRef.current.inquiryId) // F-PT-402
      const parts = partsOf(change, value.live, ids)
      if (parts.length === 0) return
      if (parts.includes('files') && tabRef.current === 'production') packRef.current.again() // F-PT-402: the pack on Production
      queueRef.current = enqueue(queueRef.current, change.type, parts, Date.now(), tabRef.current)
      setQueueTick((count) => count + 1)
    },
    () => reconnectRef.current(),
  )
  // One timer for the next due moment; what is due is read, nothing waiting is dropped.
  useEffect(() => {
    const due = nextDue(queueRef.current)
    if (due === null) return
    const timer = setTimeout(() => {
      const { read, queue } = take(queueRef.current, Date.now())
      queueRef.current = queue
      if (read.length > 0) runPartsRef.current(read)
      setQueueTick((count) => count + 1)
    }, Math.max(0, due - Date.now()))
    return () => clearTimeout(timer)
  }, [queueTick])
  // A tab that opens reads its stale parts.
  useEffect(() => {
    const { read, queue } = opened(queueRef.current, tab)
    if (read.length === 0) return
    queueRef.current = queue
    runPartsRef.current(read)
  }, [tab])
  // ---- end F-SA-239

  /** One write; the order it answers (when it answers one) replaces the page's, then the parts are read again. */
  const write = useCallback(
    async (run: () => Promise<Order | null>, success: string | null, keepDialog = false) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run()
        if (next) {
          setValue(next)
          loadParts(next)
        } else await load()
        if (!keepDialog) setDialog(null)
        if (success) setNotice({ tone: 'success', words: { key: success } })
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const words = writeProblem(error)
        if (dialogRef.current) setDialogProblem(words)
        else setNotice({ tone: 'danger', words })
        if (words.reload) void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load, loadParts, setValue],
  )

  const version = () => current.current?.version ?? 1

  // ---- F-SA-232: the production read (every part on arrival: the band's health and Overview need it); the line sizes' window is
  // use-overview-acts' (F-OP-134). F-OO-145: read before the tabs' acts — Overview's gate acts build Planning's model from it ----
  const production = useOrderProduction(api, order.status === 'ready' ? order.value.id : null)
  // ---- end F-SA-232
  // ---- F-PT-103: the order's asks and questions (the ONE issues list, orders.view), read while Production shows ----
  const asks = useOrderAsks(api, order.status === 'ready' ? order.value.id : null, tab === 'production')
  // ---- end F-PT-103
  // ---- F-PT-401 (L6): the order's styles, read once "What we make it to" came into view (product.styles.view) ----
  const [specsSeen, setSpecsSeen] = useState(false)
  const specsOrder = order.status === 'ready' ? order.value.id : null
  useEffect(() => setSpecsSeen(false), [specsOrder])
  const mayStyles = session.permissions.includes('product.styles.view')
  const specStyles = order.status === 'ready' ? styleIdsOf(order.value) : { ids: [], more: 0 }
  const styleSpecs = useStyleSpecs(api, specsOrder, specStyles.ids, mayStyles && specsSeen && tab === 'production')
  // ---- end F-PT-401
  // ---- F-OP-134 (N-5): the tabs' acts, one container hook per tab, each with the one write and the order as last read ----------------
  const ready = order.status === 'ready' ? order.value : null
  const actsBase: RecordActsBase = { api, orderId, current, write, version, setNotice, load, loadParts }
  const band = useBandActs({ ...actsBase, order: ready, permissions: session.permissions, stepUp: { ensureFresh, guard }, setDialog /* F-OP-101: the yes in place */, againProduction: production.again /* F-OO-142: a promise save reads the headline and dates again */, againAsks: asks.again /* F-PT-103 */ })
  // F-OL-05: the lines' own windows (close, reopen, cancel, split, the order fields); the old amendment draft went (use-lines-draft.ts).
  const lines = useLinesActs({
    ...actsBase,
    setDialog,
    permissions: session.permissions, // F-OP-111: the split's Ship to reads the customer's addresses (parties.view)
  })
  const productionActs = useProductionActs({
    api,
    order: ready,
    tab,
    can,
    permissions: session.permissions,
    setNotice,
    // F-OP-112: a work order made in place reads the order and its production again.
    reload: () => {
      void load()
      production.again()
    },
    // F-OP-113: a work order changed in place reads the order's work again, in place (its rows keep their places).
    rereadWork: () => production.again(['work', 'headline', 'changes']),
    offline: liveState === 'offline', // F-OP-116: the decide window holds its writes offline
    // F-PT-404 (B-PT-007): the mark reads the production read's headline (no second GET) and reads it again after a write.
    health: { view: ready && production.state?.status === 'ready' ? healthViewOf(ready, production.state.read.headline) : null, reread: () => production.again(['headline']) },
  })
  // F-OS-303: a return or a complaint opened from the Shipments tab reads the order's links again (they are read below).
  const linksAgain = useRef<() => void>(() => undefined)
  const shipments = useShipmentsActs({ order: ready, prefix, permissions: session.permissions, reload: () => void load() /* F-OP-119 */, api /* F-OP-121 */, setNotice /* F-OP-121 */, onCaseOpened: () => linksAgain.current() /* F-OS-303 */ })
  // ---- F-CP-142 (customer page plan C3): Money's "Price check" — read while Money shows, by a price holder only (else hidden, F-OM-301:
  // no call); its save and take-over say so in the page's one notice.
  const priceCheck = usePriceCheckCard({ api, orderId, can, tab, version: order.status === 'ready' ? order.value.version : null, permissions: session.permissions, setNotice })
  // ---- end F-CP-142
  // F-OM-301 / 302: read before Money's acts — an accept, a cost line or a target reads them again (the acts' rereads).
  // B-W2a-72: the Margin tab reads the order's margin while it is open.
  // F-SA-230: Margin is Money's last section (#margin), read while Money shows, with the margin grain.
  const margin = useOrderMargin(api, orderId, tab === 'money' && can.margin, session.permissions, order.status === 'ready' ? order.value.version : null)
  const money = useMoneyActs({
    ...actsBase,
    permissions: session.permissions,
    sdi,
    setSdi,
    stepUp: { ensureFresh, guard },
    onInvoiced: (invoiceId) => router.push(`${prefix}/finance/invoices/${invoiceId}?tab=lines`),
    // F-OM-203: the order as read and the page's address (Money's "Invoice shipped goods…" door into Finance).
    order: ready,
    prefix,
    rereads: { priceCheck: priceCheck.actions.onRetry, margin: margin.retry }, // F-OM-301 / 302
    me: session.user.displayName, // F-OM-fx3 (W-11): the hand windows' who line
  })
  // ---- end F-OP-134

  // B-W2b-380 (XF6:02): the lines' cost sheets (once per revision) while the Lines tab shows them, with the cost grain.
  const costChanges = useCostChanged({ api, companyId: order.status === 'ready' ? order.value.companyId : null, lines: order.status === 'ready' ? order.value.lines : NO_LINES, enabled: order.status === 'ready' && can.cost && tab === 'lines' })
  // B-W2b-323: the orders in depth (reads by tab, writes with the order's version; an answered order replaces the page's).
  const locale = useLocale()
  const depth = useOrderDepth({
    api,
    session,
    order: order.status === 'ready' ? order.value : null,
    tab,
    // F-OC-203 (L9): the confirmation is made and sent in the order's own language (the hook reads it from the order).
    onOrder: (next) => {
      setValue(next)
      loadParts(next)
    },
    onReload: () => void load(),
    onAmendDone: () => {
      setChanged(null)
      setDialog(null)
    },
  })
  packRef.current = { inquiryId: depth.model.techPack?.value?.inquiry?.id ?? null, again: () => depth.actions.onRetry?.('techPack') } // F-PT-402
  // ---- F-OL-03 (Order LINES lane): the Lines tab's draft of MY changes, Review and save, Add a style, two people — mounted after the
  // depth read (the company's freeze rules make a change priced); a door lands on a box through the page's one focus.
  const linesDraft = useLinesDraft({
    ...actsBase,
    order: ready,
    can,
    freeze: depth.model.freeze?.value ?? null,
    language: locale === 'en' ? 'en' : 'it',
    showLines: () => {
      if (tab !== 'lines') router.replace(tabAddress(pathname, window.location.search, 'lines', { narrow: narrowNow() }))
    },
    focus: (anchor) => setFocusRow({ anchor, at: Date.now() }),
    // F-OL-04: the line's ⋯ "Options and artwork…" opens today's window (OrderLineOptions, its own container) for that line.
    options: (lineId, onClose) => {
      const value = current.current
      const line = value?.lines.find((entry) => entry.id === lineId)
      return value && line ? createElement(OrderLineOptions, { key: `options-${lineId}`, api, order: value, line, permissions: session.permissions, onReload: () => void load(), opened: true, onClose }) : null
    },
    go: (href) => router.push(href), // F-OL-07: after "Leave and discard"
  })
  // ---- end F-OL-03
  // F-OO-125: a line's Change quantity or sizes… starts the amendment (Lines' acts) and focuses its style group (the page's one focus);
  // F-OO-144: the requested date's Change… opens its small dialog in the page's one slot; F-OO-210: the office note writes through
  // the Orders sheet's own write with the page's one write (the acts base).
  // F-OO-145: Next dates' gates — Planning's own dialogs from the production read's dates, their writes through the one write.
  // F-OO-106: the order's own credit hold (read with sales.credit.view); after a credit act the yes's read and the headline again.
  // F-OO-106 (walk #2): mounted after the depth read — the credit part reads the yes's read (a credit hold the order read does not name).
  // F-MS-103: the stage set by hand (production.brand.manage) — Set, Change and Clear through the one write, the headline read again.
  const overview = useOverviewActs({ setDialog /* F-OO-144 */, base: actsBase /* F-OO-210 */, gates: { production: production.state, again: production.again, permissions: session.permissions, me: session.user.id, prefix, live: liveState } /* F-OO-145 */, credit: { permissions: session.permissions, reread: () => { depth.actions.onRetry?.('approval'); production.again(['headline']) }, approval: depth.model.approval?.value ?? null /* walk #2 */ } /* F-OO-106 */, stage: { permissions: session.permissions, production: production.state, reread: () => production.again(['headline']) } /* F-MS-103: the stage set by hand, then the headline again */ })

  const reviewBanner = useReviewBanner(api, order.status === 'ready' ? order.value : null, session.permissions, prefix) // B-W2b-368
  // B-TH-256: read with the order and again whenever it is read again; an accepted or declined re-promise reads the order again.
  const links = useOrderLinks(api, order.status === 'ready' ? order.value : null, () => void load())
  linksAgain.current = () => links.actions.onRetry?.() // F-OS-303

  // ---- B-TH-228: the request an order was made from straight (no quote between) — the band's "Made from INQ-… — Open". The source
  // read answers nothing to a person who may not read that request (office only: the portal never reads it).
  // undefined: still reading (the band says nothing yet — never "Typed by the office" before it knows); null: none.
  // F-SA-230: the tech pack is read ONCE (the depth's read, also Production's Specs in force); a failed read claims nothing.
  const readsRequests = session.permissions.includes('sales.inquiries.view')
  const straight = order.status === 'ready' && order.value.chain.quote === null
  const pack = depth.model.techPack
  const madeFrom: { id: string; number: string } | null | undefined = !straight || !readsRequests || !pack ? null : pack.value ? (pack.value.inquiry ? { id: pack.value.inquiry.id, number: pack.value.inquiry.number } : null) : undefined
  // ---- end B-TH-228
  // ---- F-OO-133 (B-OO-008: the owner change emits no event): the dock changed who answers This order's conversation — People only is
  // read again (Answers the customer and why); the other parts keep their figures.
  const rereadPeople = () => production.again(['people'])
  // ---- end F-OO-133
  // ---- F-OO-213 (B-OO-014): a custom value saved on Overview moved the order's version (no live message says it) — the order is read
  // again, quietly (no loading state: the page keeps what it shows), so its next command is sent at the new version, never refused.
  const fieldsSaved = (saved: number) => {
    if ((current.current?.version ?? 0) < saved) void load()
  }
  // ---- end F-OO-213
  // ---- F-SA-234: the materials' readiness of the work orders the production read names (Production › Work orders, while it shows) ----
  const [readiness, setReadiness] = useState<Part<ReadinessRow[]> | null>(null)
  const [readinessAgain, setReadinessAgain] = useState(0) // F-PT-303: the live 'materials' part reads it again
  const readWork = production.state?.status === 'ready' ? production.state.read.work : null
  const workIds = (readWork?.workOrders ?? []).map((row) => row.id).join(',')
  useEffect(() => {
    if (tab !== 'production' || workIds === '') return setReadiness(null)
    const abort = new AbortController()
    setReadiness((known) => known ?? PART_LOADING)
    getReadiness(api, workIds.split(','), abort.signal)
      .then((rows) => !abort.signal.aborted && setReadiness(part(rows)))
      .catch((error: unknown) => !abort.signal.aborted && setReadiness({ value: null, problem: readProblem(error) }))
    return () => abort.abort()
  }, [api, tab, workIds, readinessAgain])
  // ---- end F-SA-234
  // ---- F-PT-304: Record what the customer sent… (inventory.receive) and Ask the buyers… (the Material plan's own dialog) ----
  const mayReceive = session.permissions.includes('inventory.receive')
  const receipt = useCustomerReceipt({
    api,
    order: order.status === 'ready' ? order.value : null,
    may: mayReceive,
    goods: customerGoodsOf(depth.model.materials?.value),
    onDone: (number) => {
      setNotice({ tone: 'success', words: { key: 'productionTab.receipt.done', params: { number } } })
      depth.actions.onRetry?.('materials')
      setReadinessAgain((count) => count + 1)
    },
  })
  const askBuyers = useAskBuyers({ api, prefix, permissions: session.permissions, enabled: tab === 'production', workOrders: order.status === 'ready' ? order.value.chain.workOrders : [] })
  // ---- end F-PT-304
  // F-SA-235: the order's health (raise to At risk / clear) is use-production-acts' (F-OP-134).
  // ---- F-SA-236: the order's customer requests (every state; the API's wall) and the approvals we asked it (partners.approvals.view),
  // read while Changes shows, again after each change of the order.
  const [requests, setRequests] = useState<Part<BrandRequest[]> | null>(null)
  const [askedOfCustomer, setAskedOfCustomer] = useState<Part<OfficeRequest[]> | null>(null)
  const mayAsked = session.permissions.includes('partners.approvals.view')
  const readyId = order.status === 'ready' ? order.value.id : null
  const readyVersion = order.status === 'ready' ? order.value.version : null
  const readRequests = useCallback(() => {
    if (!readyId) return
    setRequests((known) => known ?? PART_LOADING)
    listOrderRequests(api, readyId)
      .then((rows) => setRequests(part(rows)))
      .catch((error: unknown) => setRequests({ value: null, problem: readProblem(error) }))
    if (!mayAsked) return
    readRecordRequests(api, { type: 'SalesOrder', id: readyId })
      .then((answer) => setAskedOfCustomer(part(answer.requests)))
      .catch((error: unknown) => setAskedOfCustomer({ value: null, problem: readProblem(error) }))
  }, [api, readyId, mayAsked])
  // F-SA-243: read on every tab while the production read says a request waits or a change has steps left — the band notice and
  // Overview name them (none waiting: no read at all, as before).
  const changesPart = production.state?.status === 'ready' ? production.state.read.changes : undefined
  // F-SA-244: and while the order's own conversation is on the page (the dock, by default): its asks' cards draw their live chips.
  const mayThread = session.permissions.includes('threads.read')
  // Walk #3: and while an approval we asked of the customer waits — its row on Overview says its own question (partners.approvals.view).
  const asksCustomer = production.state?.status === 'ready' && (production.state.read.headline?.waiting.blockers ?? []).some((blocker) => blocker.kind === 'APPROVAL' && blocker.ref?.type === 'ApprovalRequest')
  const wantsRequests = tab === 'changes' || (changesPart?.openRequests.length ?? 0) > 0 || (changesPart?.stillToDo?.rows.length ?? 0) > 0 || mayThread || asksCustomer
  const wantsRef = useRef(wantsRequests)
  wantsRef.current = wantsRequests
  useEffect(() => {
    if (wantsRequests) readRequests()
  }, [wantsRequests, readRequests, readyVersion])
  // ---- end F-SA-236
  // ---- F-SA-243: the window on this page (`?open=<request id>`, the tab kept: Esc returns to the same tab and scroll); its ‹ › walk
  // this order's waiting requests; an answer reads the requests and the production read's changes again.
  const doorList = useMemo(() => doorListOf(requests?.value ?? []), [requests])
  const door = useRequestReviewDoor({
    ids: doorList.ids,
    batches: doorList.batches,
    offline: liveState === 'offline',
    orderId: readyId,
    onChanged: () => {
      readRequests()
      production.again(['changes', 'headline'])
      toldSoonRef.current() // F-SA-244: the change's line comes a moment after the answer
    },
  })
  // ---- end F-SA-243
  // ---- F-SA-237: the order's files, read while Files shows (the thread's window reads the same route); shared by files.manage ----
  // F-OP-125 (N-1): THE order-files container of this page — mounted once, its read kept, the same model for the Files tab and (F-OP-215)
  // the dock: one read, one count.
  const orderFiles = useOrderFiles(api, {
    orderId: readyId,
    // F-OP-215: wanted on every tab where the reader may read files — the dock's files line counts this one set (one read per page).
    enabled: tab === 'files' || session.permissions.includes('files.read'),
    partyId: order.status === 'ready' ? order.value.partyId : null,
    canShare: session.permissions.includes('files.manage'),
    onProblem: (key) => setNotice({ tone: 'danger', words: { key: key === 'order.shareFailed' ? 'files.shareFailed' : 'files.openFailed' } }),
    keep: true, // F-OP-125: the page's one read
    // F-OF-101: a block's door "Open on … ›" — the source record's own page (a change request: this order's Changes tab)
    hrefOf: (record) => (readyId ? orderFileHrefOf(record, { prefix, id: readyId, companyId: order.status === 'ready' ? order.value.companyId : null }) : null),
    // F-OF-103: "Add files…" in place — the order or one of its lines ("Line 1 · SEED-JKT-02 Black"); the session's rights until the read's `may`
    companyId: order.status === 'ready' ? order.value.companyId : null,
    lines: order.status === 'ready' ? order.value.lines.map((line) => ({ id: line.id, seq: line.seq, what: [line.style?.code, line.colourway?.name].filter(Boolean).join(' ') || null })) : [],
    canUpload: session.permissions.includes('files.upload'),
    canDelete: session.permissions.includes('files.delete'),
    // F-OF-201: "Waiting for files" — a floor ask lands on one of the order's live work orders; a closed or cancelled order holds a new ask
    // (L1); the session's rights until the read's `may` lands; Read-only acts nothing (L3); the company's day
    workOrders: order.status === 'ready' ? order.value.chain.workOrders.filter((row) => row.status !== 'CANCELLED').map((row) => ({ id: row.id, number: row.number, siteId: row.siteId })) : [],
    closed: order.status === 'ready' && (order.value.status === 'CLOSED' || order.value.status === 'CANCELLED'),
    canAsk: session.permissions.includes('tasks.manage') && session.permissions.includes('threads.post'),
    canAskCustomer: session.permissions.includes('partners.tasks.manage'),
    readOnly: readOnlyOnPage(can),
    today: romeToday(),
  })
  // ---- end F-SA-237
  // ---- F-OP-215 (11-dock §6.2): the dock gets this container (no read of its own): "All files" opens the Files tab (the dock's scope
  // kept; below 1280 px the full-width thread gives way), a tile opens the file in the ONE viewer there.
  const toFiles = () => router.replace(tabAddress(pathname, window.location.search, 'files', { narrow: narrowNow() }), { scroll: false })
  const orderFilesHost: OrderFilesHost = {
    model: orderFiles.model,
    actions: orderFiles.actions,
    reload: orderFiles.reload,
    onAll: toFiles,
    onOpen: (fileId, opener) => {
      toFiles()
      orderFiles.actions.onOrderOpen?.(fileId, 'preview', opener)
    },
  }
  // ---- end F-OP-215

  // ---- F-SA-266: "Show on the page" — the message's part: its tab (a replace: no history entry), then its row in view with the focus
  // (the row is drawn after the tab's read: looked for a few frames).
  const [focusRow, setFocusRow] = useState<{ anchor: string; at: number } | null>(null)
  const showOnPage = useCallback(
    (about: { kind: string; id: string }) => {
      const place = aboutPlace(about)
      if (!place) return
      // F-OP-210: the dock's scope kept; below 1280 px the full-width thread gives way to the row.
      router.replace(tabAddress(pathname, window.location.search, place.tab, { narrow: narrowNow(), anchor: place.anchor }), { scroll: false })
      setFocusRow({ anchor: place.anchor, at: Date.now() })
    },
    [router, pathname],
  )
  useEffect(() => {
    if (!focusRow) return
    let frames = 0
    let handle = 0
    const find = () => {
      const row = document.getElementById(focusRow.anchor)
      if (row) {
        row.scrollIntoView({ block: 'center' })
        row.focus({ preventScroll: true })
        return
      }
      if (frames++ < 60) handle = requestAnimationFrame(find)
    }
    handle = requestAnimationFrame(find)
    return () => cancelAnimationFrame(handle)
  }, [focusRow])
  // ---- end F-SA-266
  // ---- F-SA-244 (14-change-flow §4.1, §5.2): the told lines of every change of the order (ONE read for the thread's cards, History,
  // Production and Overview), again after an answer and a moment after a new message on the order's conversation; Who was told of
  // one change in its window. Only with the conversation's read right (else nothing is claimed).
  const [told, setTold] = useState<Part<ToldChanges> | null>(null)
  const [toldOpen, setToldOpen] = useState<string | null>(null)
  const readTold = useCallback(() => {
    if (!readyId || !mayThread) return
    setTold((known) => known ?? PART_LOADING)
    readToldChanges(api, readyId)
      .then((answer) => setTold(part(answer)))
      .catch((error: unknown) => setTold((known) => (known?.value ? known : { value: null, problem: readProblem(error) })))
  }, [api, readyId, mayThread])
  useEffect(() => readTold(), [readTold, readyVersion])
  const toldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  toldSoonRef.current = () => {
    if (toldTimer.current) clearTimeout(toldTimer.current)
    toldTimer.current = setTimeout(() => readTold(), 1_500)
  }
  useEffect(() => () => void (toldTimer.current && clearTimeout(toldTimer.current)), [])
  // The cards' facts: the customer's asks by their message (the requests read), each change's line (its Still to do as read now).
  const stillRead = production.state?.status === 'ready' ? production.state.read : null
  const stillRows = useMemo(() => (stillRead?.changes?.stillToDo ? stillRowsOf(stillRead) : null), [stillRead])
  const changeSide = useMemo(
    () => ({
      asks: askFactsOf(requests?.value ?? [], stillRows ?? []),
      changes: changeFactsOf(told?.value?.changes ?? [], stillRows),
      onWhoWasTold: (messageId: string) => setToldOpen(messageId),
      onStillToDo: () => {
        // Narrower than the dock: the full-width conversation gives way to the page (Back still holds the way to it; the frame keeps
        // the scope). F-OP-210: through tabAddress, the dock's scope kept docked.
        router.replace(tabAddress(pathname, window.location.search, 'changes', { narrow: narrowNow(), anchor: 'still-to-do' }), { scroll: false })
        setFocusRow({ anchor: 'still-to-do', at: Date.now() })
      },
    }),
    [requests, stillRows, told, router, pathname],
  )
  // ---- end F-SA-244

  // ---- F-SA-239: what a due part reads (the latest closures, through a ref the timer calls) ----
  runPartsRef.current = (parts) => {
    const open = dialogRef.current
    // Z02 cleanup (W11's note): the credit's Check again dialog holds nothing typed (it only says what the check does): a live change
    // reads the order under it, as under the deposit's and Before → after.
    // F-OL-03: the Lines draft no longer holds the order back — it is rebased on the fresh order (use-lines-draft.ts).
    const typed = !!open && (open.kind !== 'depositLink' && open.kind !== 'depositPayment' && open.kind !== 'compare' && open.kind !== 'creditCheck')
    const orderParts = parts.filter((part) => ORDER_PARTS.includes(part))
    if (orderParts.length > 0) {
      // Under typed work the order is not read under it: "Changed by <name> at hh:mm · Reload" (the draft is kept).
      if (typed) {
        setChanged({ at: new Date().toISOString(), parts: orderParts })
        // Who changed it: the order read's own last change, read beside the typed work (never applied under it).
        getOrder(api, orderId)
          .then((fresh) => {
            const by = changedBy(fresh.lastChange, orderParts, locale === 'en' ? 'en' : 'it')
            setChanged((known) => (known ? { ...known, by: by.name, at: by.at ?? known.at } : known))
          })
          .catch(() => undefined)
      } else void load()
    }
    const productionParts = parts.filter((part): part is 'headline' | 'lines' | 'work' | 'dates' | 'quality' | 'people' => ['headline', 'lines', 'work', 'dates', 'quality', 'people'].includes(part))
    if (productionParts.length > 0) production.again(productionParts.includes('lines') || productionParts.includes('work') ? [...new Set([...productionParts, 'headline' as const])] : productionParts)
    if (parts.includes('work') && can.viewWorkOrders && current.current && !orderParts.length)
      listOrderWorkOrders(api, current.current.id)
        .then((rows) => setWorkOrders(part(rows)))
        .catch(() => undefined)
    if (parts.includes('changes') && (tabRef.current === 'changes' || wantsRef.current /* F-SA-243 */)) readRequests()
    if (parts.includes('changes')) productionActs.rereadChanges() // F-OP-116: a work-order change proposed, applied or left as is
    if (parts.includes('quality')) asks.again() // F-PT-103: an ask raised, answered or escalated (production_issue.*)
    if (parts.includes('files')) orderFiles.reload() // F-OP-125: read again when shown, else the next time it is wanted
    // F-PT-303 (B-PT-017): the customer's goods received or used, or what we buy reserved or issued — Materials reads both again.
    if (parts.includes('materials')) {
      depth.actions.onRetry?.('materials')
      setReadinessAgain((count) => count + 1)
    }
  }
  reconnectRef.current = () => {
    void load()
    production.again()
  }
  // ---- end F-SA-239

  const model: OrderRecordModel = {
    depth: depth.model, // B-W2b-323
    reviewBanner: createElement(ReviewBanner, { model: reviewBanner.model, onRetry: reviewBanner.retry }), // B-W2b-368
    prefix,
    can,
    cancelReasons,
    today: romeToday(),
    tab,
    order,
    workOrders,
    settlement,
    sdi,
    versions,
    personId: session.user.id, // B-TH-214
    madeFrom: madeFrom ?? null, // B-TH-228
    madeFromReading: madeFrom === undefined,
    links: links.model, // B-TH-256
    production: production.state, // F-SA-232
    asks: asks.state, // F-PT-103
    styleSpecs: mayStyles ? { parts: styleSpecs.parts, more: specStyles.more } : null, // F-PT-401
    receipt: mayReceive ? { dialog: receipt.model } : null, // F-PT-304
    askBuyers: askBuyers.model, // F-PT-304
    specCan: { versions: session.permissions.includes('product.bom.view'), changeRequest: session.permissions.includes('product.changes.request') && session.permissions.includes('product.changes.view') }, // F-PT-401 (L11)
    stylesManage: session.permissions.includes('product.styles.manage'), // F-OO-121: a line's missing picture is added on its style
    readiness, // F-SA-234
    requests, // F-SA-236
    requestDoor: { parts: door, hrefOf: (id: string) => door.hrefOf(id), open: (id: string) => door.open(id) /* F-SA-244 */ }, // F-SA-243
    told, // F-SA-244
    files: orderFiles.model, // F-SA-237; F-OP-125: the page's one read, kept across tabs
    askedOfCustomer,
    liveState,
    changed,
    notice,
    busy,
    dialog,
    dialogProblem,
    stepUp,
    schedule,
    amendments,
    changeStyles,
    margin: margin.model,
    priceCheck: priceCheck.model, // F-CP-142
    priceCheckDialog: priceCheck.dialog.model, // F-CP-142
    // ---- F-OP-134: what each tab's acts hook holds (the band's portal, people and copy; Overview's line window; closed lines, the
    // cancel check; the health; the deposit's page and payment, the schedule's verbs) ----
    ...band.model,
    ...overview.model,
    ...lines.model,
    ...productionActs.model,
    ...money.model,
    ...shipments.model, // F-OP-119: the tracking dialog of the shipment opened
    // B-W2b-340 → F-OL-04: a line's options window opens from its ⋯ (linesTab.options below), no button per line any more.
    // B-W2b-380 (XF6:02)
    lineCost: order.status === 'ready' ? (line) => createElement(CostChangedMark, { key: `cost-${line.id}`, change: costChanges.get(line.id), currency: order.value.currency }) : undefined,
    linesTab: linesDraft.model, // F-OL-03
  }

  const value = order.status === 'ready' ? order.value : null
  // ---- F-OO-211 (11-design §8.1): the order's custom fields are built ONCE here and are Overview's second card beside Order facts (the
  // 7 + 8 pair), no longer the frame's slot at the body's end; the frame slot stays for every other record page. Read-only for a
  // reader who can change nothing on this page (the view's own rule): no Edit at all.
  const fieldsReadOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const customFields = value && tab === 'overview' ? <RecordCustomFields record={{ type: 'SalesOrder', id: value.id }} title={value.number} version={value.version /* F-OO-213 */} onSaved={fieldsSaved} readOnly={fieldsReadOnly} /> : null
  // ---- end F-OO-211

  // F-SA-243: "Decide for <customer>" on a counter-offer in the window reads it and the requests again once done.
  return (
    <CustomerOverrideProvider
      onDone={() => {
        door.refresh()
        readRequests()
      }}
    >
    <OrderRecordView
      model={model}
      // B-TH-214: the docked thread (Head with Activity's doors, files line, Files view, feed, box); the print view prints the thread with ThreadPrint (B-TH-280).
      // F-SA-262: the dock's pick — This order · <Customer> (general) · Projects ▾ · Work orders ▾ (office only) · All of <Customer>.
      thread={
        value ? (
          value.party ? (
            <OrderDock
              order={{ id: value.id, number: value.number, companyId: value.companyId, partyId: value.partyId, partyName: value.party.legalName, partyCode: value.party.code }}
              workOrders={dockWorkOrders(readWork, value)}
              prefix={prefix}
              printHref={printHref(pathname, params?.toString() ?? '')}
              showOnPage={showOnPage /* F-SA-266 */}
              changeSide={changeSide /* F-SA-244 */}
              orderFiles={orderFilesHost /* F-OP-215 */}
              onOwnerChanged={rereadPeople /* F-OO-133 */}
            />
          ) : (
            <OfficeRecordThread
              docked
              record={{ type: 'SalesOrder', id: value.id, companyId: value.companyId, siteId: null }}
              title={value.number}
              recordLabel={value.number}
              party={null}
              partyRole="customer"
              printHref={printHref(pathname, params?.toString() ?? '')}
              orderFiles={orderFilesHost /* F-OP-215 */}
              onOwnerChanged={rereadPeople /* F-OO-133 */}
            />
          )
        ) : null
      }
      printThread={value ? <ThreadPrint record={{ type: 'SalesOrder', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.number} · ${value.party?.legalName ?? ''}`} party={value.party ? { id: value.partyId, name: value.party.legalName } : null} /> : null}
      // B-TH-280: the order's custom fields; F-SA-233: on Overview; F-OO-211: beside Order facts (Overview's 7 + 8 pair).
      customFields={customFields}
      actions={{
        // ---- F-OP-134: each tab's acts (the band; Overview; Lines; Production; Money) ----
        ...band.actions,
        ...overview.actions,
        ...lines.actions,
        ...productionActs.actions,
        ...money.actions,
        ...shipments.actions, // F-OP-119
        // ---- end F-OP-134
        onRetry: () => void load(),
        linesTab: linesDraft.actions, // F-OL-03
        onRetryMargin: margin.retry,
        priceCheck: priceCheck.actions, // F-CP-142
        priceCheckDialog: priceCheck.dialog.actions, // F-CP-142
        links: links.actions, // B-TH-256
        // ---- F-SA-232 ----
        onRetryProduction: () => production.again(),
        onRetryAsks: asks.again, // F-PT-103
        onSpecsSeen: () => setSpecsSeen(true), // F-PT-401 (L6)
        onRetrySpec: styleSpecs.again, // F-PT-401
        onOpenOrderFile: orderFilesHost.onOpen, // F-PT-402: the ONE viewer through the order's open route
        receipt: receipt.actions, // F-PT-304
        onAskBuyers: askBuyers.open, // F-PT-304
        files: orderFiles.actions, // F-SA-237
        // ---- B-W2b-323 ----
        depth: depth.actions,
        onRetryPart: (which) => {
          if (which === 'cancelCheck') return lines.readCancelCheck() // F-OP-134: the cancel's impact check is use-lines-acts'
          if (which === 'amendments' && value) return readAmendments(value)
          if (which === 'requests') return readRequests()
          if (value) loadParts(value)
        },
        onReload: () => void load(),
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          // F-OP-134: each tab's acts clear what their last dialog showed (the cancel reads its impact check as it opens).
          band.opened(next)
          lines.opened(next)
          money.opened(next)
          // F-SA-236: Before → after reads the amendments' snapshots as it opens.
          if (next?.kind === 'compare' && current.current && !amendments?.value) readAmendments(current.current)
        },
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onWhoWasTold: (messageId) => setToldOpen(messageId), // F-SA-244: History's Told line
      }}
    />
    {/* F-SA-244: Who was told of one change (its line's card, History's Told line) — never who read it. */}
    {toldOpen && readyId && <WhoWasToldDialog orderId={readyId} messageId={toldOpen} onClose={() => setToldOpen(null)} />}
    </CustomerOverrideProvider>
  )
}

// ---- F-SA-262: the work orders the dock may show the notes of — the production read's (this reader's wall), each with its site
// from the order's chain (a floor note goes to that site's tablets); null while the read is not there. Made-to-measure units (the
// read counts them per style × colourway, without their numbers) are the chain's other work orders — only when the read left
// none out (else a unit could not be told from a work order out of this reader's reach), at most the read's count of them; one
// group names its style and colourway, several are "Made to measure".
function dockWorkOrders(work: Work | null | undefined, order: Order): (DockWorkOrderRow & { siteId: string | null })[] | null {
  if (!work) return null
  const siteOf = (id: string) => order.chain.workOrders.find((chained) => chained.id === id)?.siteId ?? null
  const listed = work.workOrders.map((row) => ({
    id: row.id,
    number: row.number,
    style: row.style ? `${row.style.code} · ${row.style.name}` : null,
    colourway: row.colourways.length > 0 ? row.colourways.map((colour) => colour.name).join(', ') : null,
    siteId: siteOf(row.id),
  }))
  const unitCount = work.mtm.reduce((sum, group) => sum + group.workOrders, 0)
  const single = work.mtm.length === 1 ? work.mtm[0]! : null
  const units =
    work.workOrdersLeftOut === 0 && unitCount > 0
      ? order.chain.workOrders
          .filter((chained) => !work.workOrders.some((row) => row.id === chained.id))
          .slice(0, unitCount)
          .map((chained) => ({ id: chained.id, number: chained.number, style: single?.style ? `${single.style.code} · ${single.style.name}` : null, colourway: single?.colourway?.name ?? null, siteId: chained.siteId, mtm: true }))
      : []
  return [...listed, ...units]
}
type DockWorkOrderRow = { id: string; number: string; style: string | null; colourway: string | null; mtm?: boolean }
// ---- end F-SA-262
