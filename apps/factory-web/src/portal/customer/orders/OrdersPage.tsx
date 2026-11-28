'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { fetchRequests, type RequestRow } from '../requests/api'
import type { OrderRow, OrdersRead } from './api'
// B-TH-246: the customer's own sheet — the list's rows with the portal columns, and "Download (Excel)" written by the server.
import { downloadSheet, fetchSheet } from './api'
import { sheetFileName } from './model'
import { saveBytes } from './hooks'
import { listBandOf } from './band'
import { NAV_KEY, NS, opens, rowHref } from './model'
// pg-w2 (portal grid plan § 3): the groups of the band, the rows of a group, the address.
import { groupOfAddress, groupQuery, holdsOrders, listRowsOf, sheetChipOf } from './list-view-model'
import type { CustomerGroup } from '../../../lib/order-groups/groups'
import { useOffline } from './hooks'
import { OrdersListView } from './view/OrdersListView'
// B-TH-230: the New messages column — one read of the rows shown (the portal's own client: its party's shared messages only).
import { readUnreadWith } from '../../../lib/last-message-cell/api'
import { useUnread } from '../../../lib/last-message-cell/use-unread'
import { threadOf } from './model'
// pg-w2 (D4): the customer's own orders' pictures (the walled partner read; one batch per page).
import { pictureReader } from '../../../lib/record-picture/api'
import { NotInAccess } from './view/parts'
import { useOrderWords } from './words'
// ---- owb-po7.2 + po7.3: the drafts bar, Send… (Review and send), Take it back, Delete the drafts, Withdrawn, the picture window.
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives' // owb-po7b: the delete question's buttons
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { DRAFT_NS } from '../../../lib/order-draft/words'
import { reviewDraftOf, sendResultsOf, type ReviewDraft } from '../../../lib/order-draft/review-send'
import { ReviewSendWindow } from '../../../lib/order-draft/view/ReviewSendWindow'
import { OrderPictureWindow } from '../../../lib/record-picture/OrderPictureWindow'
import { orderPicturePath, orderPictureSaver } from '../../../lib/record-picture/api'
import { pictureKindOf, type PictureChoice } from '../../../lib/record-picture/order-picture'
import { bulkDelete, bulkSend, discardDraft, fetchDraft, sendDraft, takeBack } from '../neworder/api'
import { fetchOrder } from './api'
import { draftsOf, listedRows, pageOf, pictureDoorOf, rowTitleOf, sentLineOf, withdrawnCount, type RowPage } from './sheet/model'
import { DraftsBar, SentLine, SHEET_NS, WithdrawnChip } from './sheet/view/SheetParts'
// ---- owb-po7b (po7.1): S2's ONE sheet part, kind `portal` (no index.ts: imported from its files), through this page's adapter.
import { OrdersSheet } from '../../../lib/orders-sheet/view/OrdersSheet'
import { SheetPicturesProvider } from '../../../lib/orders-sheet/pictures'
import { parseTarget } from '../../../lib/orders-sheet/rows'
import type { SheetCommit, SheetCommitAnswer } from '../../../lib/orders-sheet/model'
import { isPortalSheetFilter, lineIdOfKey, PORTAL_SHEET_COLUMNS, PORTAL_SHEET_FILTERS, sheetOrdersOf, type PortalSheetFilter } from './sheet/adapter'
import { ViewSwitch } from './sheet/view/SheetParts'
import { addCustomLine, changeCustomLine, changeHeader, createDraft } from '../neworder/api'
// ---- end owb-po7b
// ---- end owb-po7

/**
 * `/p/<party>/orders` for a customer — Orders & requests (B-W2b-191; B-TH-223; pg-w2 — portal grid plan § 3): reads the customer's
 * own sheet (GET /portal/sales-orders/sheet) for the group of the address (`?chip=<GROUP>`, none: everything open) and its search
 * (pages of 50 by `offset`) — its answer also carries the band's numbers, counted by the server — and the customer's requests (GET
 * /portal/inquiries, every state, up to 200: the group and the search narrow them here). Fills the band (Updated, New order, ⋯
 * Download (Excel)), tells of changes on the live channel without moving the rows ("N updates · Show"; a request's event reads the
 * requests again), and keeps what was loaded when the connection is gone. No print view, no CSV, no "On the way" any more (Z8, D7).
 */
export function CustomerOrdersPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists', DRAFT_NS /* owb-po7: Review and send */, SHEET_NS /* owb-po7: the sheet's parts */]}>
      <Suspense fallback={null}>
        <OrdersRoute />
      </Suspense>
    </WithMessages>
  )
}

function OrdersRoute() {
  const frame = usePortalFrame()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.salesOrders.view')
  const { t } = useOrderWords()
  if (!allowed) return <Closed title={t('list.title')} />
  return <ListContainer />
}

export function Closed({ title }: { title: string }) {
  const frame = usePortalFrame()
  usePortalBand({ title })
  return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
}

function ListContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useOrderWords()
  const { t, locale } = words
  const offline = useOffline()
  const group: CustomerGroup | null = groupOfAddress(search?.get('chip'))
  const q = search?.get('q') ?? ''
  const orders = holdsOrders(group)
  // B-TH-223: the requests are read whole (every state) and narrowed here; a reader without the orders' right reads none.
  const seesRequests = frame.me.permissions.includes('portal.salesOrders.view')
  const [requests, setRequests] = useState<{ state: 'loading' | 'error' | 'ready' | 'none'; rows: RequestRow[]; complete: boolean }>({ state: seesRequests ? 'loading' : 'none', rows: [], complete: true })

  const [read, setRead] = useState<OrdersRead | null>(null)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [updates, setUpdates] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const reading = useRef<AbortController | null>(null)
  // owb-po7b: Sheet (the default) or List (`?view=list` keeps it); the sheet's filter tab reads today's chips (All · In work · Shipped ·
  // Delivered). The list keeps its groups band as before.
  const [view, setView] = useState<'sheet' | 'list'>(() => (search?.get('view') === 'list' ? 'list' : 'sheet'))
  const [sheetFilter, setSheetFilter] = useState<PortalSheetFilter>('ALL')
  const sheetMode = view === 'sheet'
  const chipNow = sheetMode ? sheetFilter : sheetChipOf(group)
  const ordersNow = sheetMode || orders

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      // The sheet's read: the group's rows with their portal columns, and the band's numbers (the server's, before the search). Closed
      // requests hold no order: the read then brings the band's numbers only.
      // owb-po7: the drafts come with the sheet (the drafts bar holds them) for a reader who keeps drafts.
      const next = await fetchSheet(api, { chip: chipNow, q, ...(ordersNow ? {} : { limit: 1 }), ...(frame.me.permissions.includes('portal.orderDrafts.edit') ? { drafts: true } : {}) }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setRows(ordersNow ? next.items : [])
      setState('ready')
      setUpdates(0)
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, q, chipNow, ordersNow])

  const loadRequests = useCallback(async () => {
    if (!seesRequests) return
    try {
      const next = await fetchRequests(api, { state: 'ALL', limit: 200 })
      setRequests({ state: 'ready', rows: next.rows, complete: next.complete })
    } catch {
      setRequests((current) => ({ ...current, state: 'error' }))
    }
  }, [api, seesRequests])
  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  useEffect(() => {
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load])

  // J / K on an order walk the list the person came from.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(NAV_KEY, JSON.stringify(rows.filter(opens).map((row) => row.id)))
    } catch {
      // No storage (a private window): J / K simply have no list.
    }
  }, [rows])

  usePortalLive({
    onChange: (change) => {
      if (read?.live.events.includes(change.type)) setUpdates((count) => count + 1)
      // B-TH-223: a request of this customer moved (our answer, a quote, its order): its row reads again in place.
      if (change.type.startsWith('inquiry.')) void loadRequests()
    },
    onReconnect: () => {
      setUpdates((count) => count + 1)
      void loadRequests()
    },
  })

  const more = async () => {
    if (!read || loadingMore || !ordersNow) return
    setLoadingMore(true)
    try {
      const next = await fetchSheet(api, { chip: chipNow, q, offset: rows.length }) // B-TH-246
      setRows((current) => [...current, ...next.items.filter((row) => !current.some((old) => old.id === row.id))])
    } catch {
      setState('error')
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (nextGroup: CustomerGroup | null, nextQ: string) => router.replace(`${pathname}${groupQuery(nextGroup, nextQ)}`, { scroll: false })
  const shownRows = listRowsOf(group, q, requests.state === 'ready' ? requests.rows : [], rows, locale)

  // B-W2b-194: New order (a person who may order, not in a preview).
  const newOrder = frame.me.permissions.includes('portal.orderRequests.manage') && !frame.me.preview ? `${frame.prefix}/orders/new` : null
  // ── B-TH-246, Z8: "Download (Excel)" of the group shown — the server writes the file in the customer's own scope (never the office's
  // export job); under Requests it holds the order requests (the inquiries are not in the file); Closed requests holds no order.
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const downloadAll = async () => {
    setDownloading(true)
    setDownloadFailed(false)
    try {
      const file = await downloadSheet(api, { chip: sheetChipOf(group), q, format: 'XLSX', locale: locale === 'it' ? 'it' : 'en' })
      saveBytes(file.fileName ?? sheetFileName(t('list.fileName'), 'XLSX'), file.bytes, file.contentType)
    } catch {
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }
  // ── end B-TH-246 ──
  usePortalBand(state === 'forbidden' ? { title: t('list.title') } : listBandOf({ words, asOf: read?.asOf ?? null, newOrder, ...(orders ? { onDownloadAll: () => void downloadAll() } : {}), downloading /* B-TH-246 */ }))

  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  useEffect(() => {
    if (read) setLoadedAt(read.asOf)
  }, [read])

  // ---- B-TH-230: the person's own new messages on the rows shown (threads.read; ONE POST /threads/unread of ≤ 200), again live ----
  const readsThreads = frame.me.permissions.includes('threads.read')
  const [unreadTick, setUnreadTick] = useState(0)
  usePortalLive({ onChange: (change) => (change.type.startsWith('thread.') || change.type === 'partner_notification.created' ? setUnreadTick((tick) => tick + 1) : undefined), onReconnect: () => setUnreadTick((tick) => tick + 1) }, readsThreads)
  const unreadRows = useMemo(() => shownRows.flatMap((row) => { const thread = threadOf(row); return thread ? [{ recordType: thread.recordType, id: row.id }] : [] }), [shownRows])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  // ---- end B-TH-230
  // pg-w2 (D4): one picture reader for the page (the shared picture part batches the rows' asks; a 404 before the route: no picture).
  const pictures = useMemo(() => pictureReader(api), [api])

  // ---- owb-po7.2 + po7.3 ---------------------------------------------------------------------------------------------------------
  const ts = useT(SHEET_NS)
  const mayOrder = frame.me.permissions.includes('portal.orderRequests.manage') && !frame.me.preview
  const mayDraft = frame.me.permissions.includes('portal.orderDrafts.edit') && !frame.me.preview
  const [showWithdrawn, setShowWithdrawn] = useState(false)
  const [sentIds, setSentIds] = useState<string[]>([])
  const [sentState, setSentState] = useState<{ busy: boolean; refused: string | null }>({ busy: false, refused: null })
  const [notice, setNotice] = useState<string | null>(null)
  const [review, setReview] = useState<{ drafts: ReviewDraft[]; currency: string; busy: boolean; note: string; results: ReturnType<typeof sendResultsOf> | null } | null>(null)
  const [picture, setPicture] = useState<{ page: RowPage; number: string; subject: string | null; version: number; fileId: string | null; choices: PictureChoice[] } | null>(null)
  const [draftsBusy, setDraftsBusy] = useState(false)
  const drafts = draftsOf(rows)
  const heldOffline = offline ? t('held.offline') : null
  /** A refusal in this page's own words, by its kind (never the API's sentence). */
  const refusalWords = (error: unknown): string => {
    const kind = isApiError(error) ? error.kind : null
    return kind === 'conflict' ? ts('ordersSheet.refusedConflict') : kind === 'forbidden' ? ts('ordersSheet.refusedAccess') : ts('ordersSheet.failed')
  }
  /** Send… → "Review and send" for the drafts (each read for its version, its lines and its list prices). */
  const openReview = async (ids?: readonly string[]) => {
    // owb-po7b: the sheet's Send… (one row) or its bulk bar (the drafts picked); the drafts bar sends them all.
    const chosen = ids ? drafts.filter((row) => ids.includes(row.id)) : drafts
    if (chosen.length === 0) return
    setReview({ drafts: [], currency: 'EUR', busy: true, note: '', results: null })
    try {
      const records = await Promise.all(chosen.map((row) => fetchDraft(api, row.id)))
      setReview({ drafts: records.map((record, index) => reviewDraftOf(record, rowTitleOf(chosen[index]!) ?? ts('ordersSheet.noSubject'))), currency: records[0]?.request.currency ?? 'EUR', busy: false, note: '', results: null })
    } catch (error) {
      setReview(null)
      setNotice(refusalWords(error))
    }
  }
  const sendReviewed = async () => {
    if (!review || review.busy) return
    setReview({ ...review, busy: true })
    try {
      if (review.drafts.length === 1) {
        const one = review.drafts[0]!
        await sendDraft(api, one.id, one.version, newIdempotencyKey())
        setReview(null)
        setSentIds([one.id])
      } else {
        const answer = await bulkSend(api, review.drafts.map((draft) => ({ id: draft.id, version: draft.version })), newIdempotencyKey())
        const results = sendResultsOf(answer.results, review.drafts, locale === 'it' ? 'it' : 'en', ts('ordersSheet.failed'))
        setReview({ ...review, busy: false, results })
        setSentIds(answer.results.filter((entry) => entry.ok).map((entry) => entry.id))
      }
      frame.refreshTasks()
      void load()
    } catch (error) {
      setReview((now) => (now ? { ...now, busy: false, results: { sent: 0, refused: now.drafts.map((draft) => ({ id: draft.id, title: draft.title, words: refusalWords(error) })) } } : now))
    }
  }
  /** Take it back: each sent order the factory has not confirmed goes back to a draft (its number kept). */
  const takeItBack = async (ids: readonly string[]) => {
    setSentState({ busy: true, refused: null })
    let back = 0
    let refused: string | null = null
    for (const id of ids) {
      try {
        const record = await fetchDraft(api, id)
        await takeBack(api, id, record.request.version, newIdempotencyKey())
        back += 1
      } catch (error) {
        refused = refusalWords(error)
      }
    }
    setSentState({ busy: false, refused })
    if (back > 0) {
      setSentIds([])
      setNotice(ts('ordersSheet.takenBack', { count: back }))
    }
    void load()
  }
  /** Delete the drafts (one: the draft's own delete; many: one answer per draft). A numbered draft is withdrawn, not deleted (the server's G1). */
  const deleteDrafts = async (ids: readonly string[]) => {
    setDraftsBusy(true)
    try {
      const items = await Promise.all(ids.map(async (id) => ({ id, version: rows.find((row) => row.id === id)?.version ?? (await fetchDraft(api, id)).request.version })))
      if (items.length === 1) await discardDraft(api, items[0]!.id, items[0]!.version, newIdempotencyKey())
      else {
        const answer = await bulkDelete(api, items, newIdempotencyKey())
        const refused = answer.results.filter((entry) => !entry.ok)
        if (refused.length > 0) setNotice(refused.map((entry) => entry.words?.[locale === 'it' ? 'it' : 'en'] ?? ts('ordersSheet.failed')).join(' · '))
      }
    } catch (error) {
      setNotice(refusalWords(error))
    } finally {
      setDraftsBusy(false)
      void load()
    }
  }
  /** The picture of a row: its record read for its version (and a draft's files), then the window; you stay on the orders page. */
  const openPicture = async (order: OrderRow) => {
    const page = pictureDoorOf(order)
    if (!page) return
    const subject = rowTitleOf(order)
    try {
      if (page.kind === 'request') {
        const record = await fetchDraft(api, page.id)
        const files = record.request.files ? [...record.request.files.logos, ...record.request.files.references] : []
        const choices = files.filter((file) => file.contentType.startsWith('image/') || file.contentType === 'application/pdf').map((file) => ({ fileId: file.id, name: file.originalName ?? '—', kind: pictureKindOf({ type: file.contentType, name: file.originalName ?? '' }), small: null }))
        setPicture({ page, number: ts('ordersSheet.yourOrder'), subject, version: record.request.version, fileId: record.request.picture?.fileId ?? null, choices })
      } else {
        const record = await fetchOrder(api, page.id)
        setPicture({ page, number: order.yourNumber ? order.yourNumber.words[locale === 'it' ? 'it' : 'en'] : ts('ordersSheet.yourOrder'), subject, version: record.order.version, fileId: null, choices: [] })
      }
    } catch (error) {
      setNotice(refusalWords(error))
    }
  }
  const pageHref = (page: RowPage | null): string | null => (page ? (page.kind === 'order' ? `${frame.prefix}/orders/${encodeURIComponent(page.id)}` : `${frame.prefix}/orders/requests/${encodeURIComponent(page.id)}`) : null)
  const sentLine = sentLineOf(rows, sentIds)

  // ---- owb-po7b (po7.1): the sheet's own doors — a typed cell of a draft saved in place, the "New order" row makes a draft and opens
  // nothing, every number / chip / picture / bin a door, the bulk bar (Send… · Delete the drafts · Export). A delete always asks first.
  const [askDelete, setAskDelete] = useState<readonly string[] | null>(null)
  const draftOf = (key: string) => rows.find((row) => row.id === key && row.kind === 'DRAFT')
  const commitSheet = async (commit: SheetCommit): Promise<SheetCommitAnswer> => {
    const order = draftOf(commit.orderKey)
    if (!order) return { kind: 'REFUSED', words: ts('ordersSheet.typeDraftOnly') }
    try {
      const record = await fetchDraft(api, order.id)
      const version = record.request.version
      const value = commit.value.trim()
      if (commit.lineKey === null) {
        if (commit.column === 'what') await changeHeader(api, order.id, { version, subject: value === '' ? null : value }, newIdempotencyKey())
        else if (commit.column === 'wanted') await changeHeader(api, order.id, { version, requestedDate: value === '' ? null : value }, newIdempotencyKey())
        else return { kind: 'REFUSED', words: ts('ordersSheet.typeInWindow') }
      } else {
        // A line in the customer's own words takes its words and a total here; a catalogue line, its material and its sizes are typed in
        // the New order window (they are a colour, an option, a size run there).
        const line = (record.request.customLines ?? []).find((entry) => entry.id === lineIdOfKey(commit.lineKey!))
        if (!line || line.byPerson || (commit.column !== 'what' && commit.column !== 'pieces')) return { kind: 'REFUSED', words: ts('ordersSheet.typeInWindow') }
        const total = /^\d+$/.test(value) ? Number(value) : null
        if (commit.column === 'pieces' && value !== '' && (total === null || total < 1)) return { kind: 'REFUSED', words: ts('ordersSheet.typePieces') }
        await changeCustomLine(api, order.id, line.id, commit.column === 'pieces' ? { version, byPerson: false, quantity: total, sizes: [] } : { version, description: value === '' ? null : value }, newIdempotencyKey())
      }
      void load()
      return { kind: 'SAVED' }
    } catch (error) {
      return { kind: 'REFUSED', words: refusalWords(error) }
    }
  }
  /** The "New order" row: what is typed makes a draft (the subject, the date wanted, or a line in the customer's words) and opens nothing. */
  const newOrderFromSheet = async (seed: { column: string; value: string }) => {
    const value = seed.value.trim()
    if (value === '' || offline) return
    try {
      const made = await createDraft(api, { source: 'PICKER', ...(seed.column === 'what' ? { subject: value } : seed.column === 'wanted' ? { requestedDate: value } : {}) }, newIdempotencyKey())
      if (seed.column === 'pieces' || seed.column === 'material' || seed.column === 'sizes') {
        const total = /^\d+$/.test(value) ? Number(value) : null
        await addCustomLine(api, made.request.id, { version: made.request.version, line: { kind: 'DESCRIBED', ...(seed.column === 'pieces' && total ? { quantity: total } : { description: value }) } }, newIdempotencyKey())
      }
    } catch (error) {
      setNotice(refusalWords(error))
    }
    void load()
  }
  /** A door of the sheet (`act:key`): the order's page, its chat, the design, the picture, a line to add, the bin, Send…. */
  const openTarget = (target: string) => {
    const { act, key } = parseTarget(target)
    const row = rows.find((entry) => entry.id === key)
    if (!row) return
    const href = pageHref(pageOf(row))
    if (act === 'picture') void openPicture(row)
    else if (act === 'deleteDraft') setAskDelete([row.id])
    else if (act === 'send') void openReview([row.id])
    else if (act === 'addLine' && row.kind === 'DRAFT') router.push(`${frame.prefix}/orders/new?draft=${encodeURIComponent(row.id)}`)
    else if (act === 'chat' && href) router.push(`${href}?thread=open`)
    else if (href) router.push(href)
  }
  const pickView = (next: 'sheet' | 'list') => {
    setView(next)
    const params = new URLSearchParams(search?.toString() ?? '')
    if (next === 'list') params.set('view', 'list')
    else params.delete('view')
    const query = params.toString()
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false })
  }
  // ---- end owb-po7b
  const above = (
    <>
      <span className="fw-pos-bar">
        <ViewSwitch view={view} onPick={pickView} />
      </span>
      {askDelete ? (
        <Banner
          tone="warning"
          title={askDelete.length === 1 ? ts('ordersSheet.deleteOne', { title: rowTitleOf(rows.find((row) => row.id === askDelete[0]) ?? { subject: null, customerRef: null }) ?? ts('ordersSheet.noSubject') }) : ts('ordersSheet.deleteAll', { count: askDelete.length })}
          action={
            <span className="fw-pos-acts">
              <Button size="sm" onClick={() => setAskDelete(null)}>
                {ts('ordersSheet.cancel')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                heldReason={heldOffline}
                onClick={() => {
                  const ids = askDelete
                  setAskDelete(null)
                  void deleteDrafts(ids)
                }}
              >
                {ts('ordersSheet.delete')}
              </Button>
            </span>
          }
        />
      ) : null}
      {notice ? <Banner tone="info" title={notice} action={<button type="button" className="fw-pos-chip" onClick={() => setNotice(null)}>{ts('ordersSheet.ok')}</button>} /> : null}
      {sentLine ? (
        <SentLine
          model={{ titles: sentLine.titles, takeBack: mayOrder && sentLine.takeBack.length > 0, busy: sentState.busy, refused: sentState.refused }}
          onTakeBack={() => void takeItBack(sentLine.takeBack)}
          onOk={() => {
            setSentIds([])
            setSentState({ busy: false, refused: null })
          }}
        />
      ) : null}
      {mayDraft ? (
        <DraftsBar
          model={{
            drafts: drafts.map((row) => ({ id: row.id, title: rowTitleOf(row), href: `${frame.prefix}/orders/new?draft=${encodeURIComponent(row.id)}` })),
            sendHeld: heldOffline ?? (mayOrder ? null : ts('ordersSheet.sendNotYours')),
            deleteHeld: heldOffline,
            busy: draftsBusy || review !== null,
          }}
          actions={{ onSend: () => void openReview(), onDelete: (ids) => void deleteDrafts(ids) }}
        />
      ) : null}
      <span className="fw-pos-bar">
        <WithdrawnChip count={withdrawnCount(rows)} shown={showWithdrawn} onToggle={() => setShowWithdrawn(!showWithdrawn)} />
      </span>
    </>
  )
  // ---- end owb-po7

  if (state === 'forbidden') return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  const list = (
    <OrdersListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        rows: listedRows(rows, showWithdrawn), // owb-po7.2: drafts sit in the drafts bar; withdrawn rows behind their chip
        requests,
        group,
        q,
        prefix: frame.prefix,
        updates,
        offlineSince: offline ? loadedAt : null,
        more: read && orders && rows.length < read.count ? { loading: loadingMore } : null,
        // B-W2b-194: the empty state's New order (only who may order: G1-B11).
        newOrderHref: newOrder,
        unread: readsThreads ? unread : null, // B-TH-230
        downloadFailed, // B-TH-246
        pictures,
      }}
      actions={{
        onGroup: (next) => go(next, q),
        onSearch: (next) => go(group, next),
        onClearSearch: () => go(group, ''),
        onOpen: (row) => {
          const href = rowHref(frame.prefix, row)
          if (href) router.push(href)
        },
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onRetryRequests: () => {
          setRequests((current) => ({ ...current, state: 'loading' }))
          void loadRequests()
        },
        onDownloadAll: () => void downloadAll(), // B-TH-246: Try again
        // owb-po7.3: the picture window here; a "Waits · news" chip opens the chat, the design or the order.
        onPicture: (order) => void openPicture(order),
        onWait: (order, chip) => {
          const href = pageHref(pageOf(order))
          if (href) router.push(chip.door === 'chat' ? `${href}?thread=open` : href)
        },
      }}
      above={above}
    />
  )
  // owb-po7b (po7.1): the Sheet — S2's ONE part, kind `portal`, fed by this page's adapter; no price column for anybody. The office-ticked
  // portal columns and "Download (Excel)" stay (the List shows the columns; the band and Export keep the file).
  const sheetOrders = sheetMode ? sheetOrdersOf(rows, { locale: locale === 'it' ? 'it' : 'en', t: ts, ownColumns: read?.ownColumns ?? [] }, showWithdrawn) : []
  const sheet = (
    <div className="fw-pos-top">
      {above}
      <SheetPicturesProvider value={{ read: pictures, sourceOf: (record) => (record.kind === 'REQUEST' ? 'customerRequest' : 'customerOrder') }}>
        <OrdersSheet
          kind="portal"
          orders={sheetOrders}
          columns={PORTAL_SHEET_COLUMNS}
          filters={{ items: PORTAL_SHEET_FILTERS.map((id) => ({ id, words: ts(`ordersSheet.filter.${id}`) })), active: sheetFilter, onPick: (id) => (isPortalSheetFilter(id) ? setSheetFilter(id) : undefined) }}
          onCommit={commitSheet}
          onOpen={openTarget}
          {...(mayDraft ? { onNewOrder: (seed: { column: string; value: string }) => newOrderFromSheet(seed) } : {})}
          bulk={[
            ...(mayOrder ? [{ id: 'send', words: ts('ordersSheet.send'), icon: 'send', primary: true, run: (keys: readonly string[]) => void openReview(keys) }] : []),
            ...(mayDraft ? [{ id: 'deleteDrafts', words: ts('ordersSheet.deleteDrafts'), icon: 'trash-2', run: (keys: readonly string[]) => { const ids = keys.filter((key) => draftOf(key)); if (ids.length > 0) setAskDelete(ids) } }] : []),
            { id: 'export', words: ts('ordersSheet.export'), icon: 'download', run: () => void downloadAll() },
          ]}
          live={{ lastChange: read?.asOf ?? null, flashKeys: [] }}
          loading={state === 'loading' && !read}
          error={state === 'error' ? ts('ordersSheet.failed') : null}
        />
      </SheetPicturesProvider>
      {read && rows.length < read.count ? (
        <span className="fw-pos-bar">
          <Button size="sm" heldReason={loadingMore ? ts('ordersSheet.busy') : heldOffline} onClick={() => void more()}>
            {ts('ordersSheet.showMore')}
          </Button>
        </span>
      ) : null}
    </div>
  )
  // The windows over the page: Review and send, the picture of the order.
  return (
    <>
      {sheetMode ? sheet : list}
      {review ? (
        <ReviewSendWindow
          model={{ open: true, drafts: review.drafts, currency: review.currency, note: review.note, noteDoor: false, held: review.busy && review.drafts.length === 0 ? ts('ordersSheet.busy') : mayOrder ? heldOffline : ts('ordersSheet.sendNotYours'), busy: review.busy, results: review.results }}
          actions={{ onClose: () => setReview((now) => (now?.busy ? now : null)), onSend: () => void sendReviewed() }}
        />
      ) : null}
      {picture ? (
        <OrderPictureWindow
          open
          onClose={() => setPicture(null)}
          number={picture.number}
          subject={picture.subject}
          record={{ source: picture.page.kind === 'request' ? 'customerRequest' : 'customerOrder', recordId: picture.page.id }}
          now={{ fileId: picture.fileId, version: picture.version }}
          choices={picture.choices}
          save={orderPictureSaver(api, orderPicturePath('portal', picture.page.kind, picture.page.id))}
          onSaved={() => void load()}
        />
      ) : null}
    </>
  )
}
