'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOrderMargin } from './margin/use-margin'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { findStyles, getStyle, listVersions, type StyleDetail, type VersionsAnswer } from '../../quotes/api'
import {
  applyAmendment,
  cancelOrder,
  changePromise,
  closeLines,
  closeOrder,
  copyAsQuote,
  getCancelCheck,
  getSchedule,
  listAmendments,
  previewAmendment,
  reopenLines,
  getOrder,
  getSdi,
  getSettlement,
  listOrderWorkOrders,
  markReady,
  recordDepositPayment,
  sendDepositLink,
  sendToSdi,
  type AmendmentsAnswer,
  type CancelCheck,
  type CloseLinesAnswer,
  type CopyAnswer,
  type DepositLinkAnswer,
  type DepositReceived,
  type Order,
  type Schedule,
  type OrderWorkOrder,
  type SdiStatus,
  type Settlement,
} from '../api'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp, useThreadDock } from '../hooks'
import { amendLines, draftOf, newKey, withCells } from '../daily-model'
import { abilitiesOf, knownIds, liveTouches, readProblem, romeToday, tabOf, writeProblem, type SizeLayer } from '../model'
import { COMPOSER_EMPTY, PART_LOADING, type AmendState, type Loaded, type OrderRecordModel, type Part, type RecordDialog } from './record-model'
import { OrderRecordView } from './view/OrderRecordView'

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
 */
export function OrderRecord({ orderId }: { orderId: string }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists', 'records']}>
      <RecordContainer orderId={orderId} />
    </WithMessages>
  )
}

const part = <T,>(value: T): Part<T> => ({ value, problem: null })
/** The reason the review's preview is asked with (the preview writes nothing; Apply sends the typed reason). */
const PREVIEW_REASON = 'Review before applying.'
const ISSUED = (status: string) => status !== 'DRAFT'

function RecordContainer({ orderId }: { orderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/sales\/orders\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])

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
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [sentLink, setSentLink] = useState<DepositLinkAnswer | null>(null)
  const [recorded, setRecorded] = useState<DepositReceived | null>(null)
  const [sizeLayer, setSizeLayer] = useState<SizeLayer>('ordered')
  const [amend, setAmend] = useState<AmendState | null>(null)
  const amendRef = useRef<AmendState | null>(null)
  amendRef.current = amend
  const [schedule, setSchedule] = useState<Part<Schedule> | null>(null)
  const [amendments, setAmendments] = useState<Part<AmendmentsAnswer> | null>(null)
  const [changeStyles, setChangeStyles] = useState<Record<string, StyleDetail | null | undefined>>({})
  const [cancelCheck, setCancelCheck] = useState<Part<CancelCheck> | null>(null)
  const [closedLines, setClosedLines] = useState<CloseLinesAnswer | null>(null)
  const [copied, setCopied] = useState<CopyAnswer | null>(null)
  const searchSeq = useRef(0)
  const { dockOpen, toggleDock } = useThreadDock()
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
      if (value.amendments.count === 0) setAmendments(part({ orderId: value.id, number: value.number, reapprovalNeededAt: value.reapprovalNeededAt, amendments: [] }))
      else {
        setAmendments((known) => known ?? PART_LOADING)
        listAmendments(api, value.id)
          .then((answer) => {
            setAmendments(part(answer))
            // A line the order no longer holds is named by its style (codes): read the styles it does not hold.
            const own = new Set(value.lines.map((line) => line.styleId))
            const missing = [...new Set(answer.amendments.flatMap((entry) => entry.diff.lines.map((line) => line.styleId)))].filter((styleId) => !own.has(styleId))
            for (const styleId of missing)
              getStyle(api, styleId)
                .then((style) => setChangeStyles((known) => ({ ...known, [styleId]: style })))
                .catch(() => setChangeStyles((known) => ({ ...known, [styleId]: null })))
          })
          .catch((error: unknown) => setAmendments({ value: null, problem: readProblem(error) }))
      }
    },
    [api, can.viewWorkOrders, can.viewInvoices, can.viewQuotes],
  )

  const setValue = useCallback((next: Order) => {
    current.current = next
    setOrder({ status: 'ready', value: next })
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getOrder(api, orderId)
      setValue(next)
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

  // Live: an event that names this order or a record of its chain; a dialog with typed work open → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const known = order.status === 'ready' ? knownIds(order.value) : null
  const knownRef = useRef(known)
  knownRef.current = known
  const live = useLive(
    (change) => {
      if (!knownRef.current || !liveTouches(change, knownRef.current)) return
      const open = dialogRef.current
      if (amendRef.current || (open && open.kind !== 'depositLink' && open.kind !== 'depositPayment' && open.kind !== 'compare')) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

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

  // ---- B-W2a-50: the amendment draft --------------------------------------------------------------------------------
  const readStyle = useCallback(
    (styleId: string) =>
      getStyle(api, styleId)
        .then((style) => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: style } } : known)))
        .catch(() => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: null } } : known))),
    [api],
  )
  const startAmend = () => {
    const value = current.current
    if (!value) return
    const styleIds = [...new Set(value.lines.map((line) => line.styleId))]
    setNotice(null)
    setAmend({
      revision: (value.amendments.latestRevision ?? 0) + 1,
      lines: draftOf(value),
      customerRef: value.customerRef ?? '',
      requestedDate: value.requestedDate ?? '',
      styles: Object.fromEntries(styleIds.map((styleId) => [styleId, undefined])),
      composer: COMPOSER_EMPTY,
      review: null,
    })
    if (tab !== 'lines') router.replace(`${pathname}?tab=lines`)
    for (const styleId of styleIds) void readStyle(styleId)
  }
  const amendBody = (draft: AmendState, value: Order) => {
    const customerRef = draft.customerRef.trim() || null
    const requestedDate = draft.requestedDate || null
    return {
      lines: amendLines(draft.lines, value),
      ...(customerRef !== (value.customerRef ?? null) ? { customerRef } : {}),
      ...(requestedDate !== (value.requestedDate ?? null) ? { requestedDate } : {}),
    }
  }
  const review = () => {
    const draft = amendRef.current
    const value = current.current
    if (!draft || !value) return
    setDialog({ kind: 'amendReview' })
    setDialogProblem(null)
    setAmend((known) => (known ? { ...known, review: { phase: 'reading', preview: null, problem: null } } : known))
    // The API checks a reason in the preview too: it is asked with a stand-in (nothing is written); the dialog asks the
    // real reason before Apply, which sends it.
    previewAmendment(api, orderId, { version: value.version, reason: PREVIEW_REASON, ...amendBody(draft, value) })
      .then((preview) => setAmend((known) => (known ? { ...known, review: { phase: 'ready', preview, problem: null } } : known)))
      .catch((error: unknown) => {
        const words = writeProblem(error)
        setAmend((known) => (known ? { ...known, review: { phase: 'failed', preview: null, problem: words } } : known))
        if (words.reload) void load()
      })
  }
  const composerQuery = (query: string) => {
    const mine = ++searchSeq.current
    const companyId = current.current?.companyId ?? null
    if (query.trim() === '') {
      setAmend((known) => (known ? { ...known, composer: { ...known.composer, query: '', results: null, searching: false, problem: null } } : known))
      return
    }
    setAmend((known) => (known ? { ...known, composer: { ...known.composer, query, searching: true, problem: null } } : known))
    findStyles(api, query, companyId)
      .then((results) => mine === searchSeq.current && setAmend((known) => (known ? { ...known, composer: { ...known.composer, results, searching: false } } : known)))
      .catch((error: unknown) => mine === searchSeq.current && setAmend((known) => (known ? { ...known, composer: { ...known.composer, searching: false, problem: readProblem(error) } } : known)))
  }
  const composerPick = (styleId: string | null) => {
    if (!styleId) {
      setAmend((known) => (known ? { ...known, composer: { ...known.composer, chosen: null, picked: [] } } : known))
      return
    }
    getStyle(api, styleId)
      .then((style) => setAmend((known) => (known ? { ...known, styles: { ...known.styles, [styleId]: style }, composer: { ...known.composer, chosen: style, picked: [] } } : known)))
      .catch((error: unknown) => setAmend((known) => (known ? { ...known, composer: { ...known.composer, problem: readProblem(error) } } : known)))
  }
  const composerAdd = () =>
    setAmend((known) => {
      const chosen = known?.composer.chosen
      if (!known || !chosen) return known
      const have = new Set(known.lines.filter((line) => line.styleId === chosen.id).map((line) => line.colourwayId))
      const added = known.composer.picked.filter((colourwayId) => !have.has(colourwayId)).map((colourwayId) => ({ key: newKey(chosen.id, colourwayId), lineId: null, styleId: chosen.id, colourwayId, sizes: {}, price: '', locked: false }))
      return { ...known, lines: [...known.lines, ...added], composer: COMPOSER_EMPTY }
    })

  // B-W2a-72: the Margin tab reads the order's margin while it is open.
  const margin = useOrderMargin(api, orderId, tab === 'margin', session.permissions, order.status === 'ready' ? order.value.version : null)

  const model: OrderRecordModel = {
    prefix,
    can,
    today: romeToday(),
    tab,
    order,
    workOrders,
    settlement,
    sdi,
    versions,
    live,
    dockOpen,
    changed,
    notice,
    busy,
    dialog,
    dialogProblem,
    sentLink,
    recorded,
    stepUp,
    sizeLayer,
    amend,
    schedule,
    amendments,
    changeStyles,
    cancelCheck,
    closedLines,
    copied,
    margin: margin.model,
  }

  const value = order.status === 'ready' ? order.value : null

  return (
    <OrderRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'SalesOrder', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.number} · ${value.party?.legalName ?? ''}`} party={value.party ? { id: value.partyId, name: value.party.legalName, emails: [] } : null} /> : null}
      actions={{
        onRetry: () => void load(),
        onRetryMargin: margin.retry,
        onRetryPart: (which) => {
          if (which === 'cancelCheck') {
            setCancelCheck(PART_LOADING)
            getCancelCheck(api, orderId)
              .then((answer) => setCancelCheck(part(answer)))
              .catch((error: unknown) => setCancelCheck({ value: null, problem: readProblem(error) }))
            return
          }
          if (value) loadParts(value)
        },
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          setSentLink(null)
          setRecorded(null)
          setClosedLines(null)
          setCopied(null)
          if (next?.kind === 'cancel') {
            setCancelCheck(PART_LOADING)
            getCancelCheck(api, orderId)
              .then((answer) => setCancelCheck(part(answer)))
              .catch((error: unknown) => setCancelCheck({ value: null, problem: readProblem(error) }))
          }
        },
        onPromise: ({ date, reason, lineIds }) => void write(() => changePromise(api, orderId, { version: version(), promiseDate: date, reason, ...(lineIds ? { lineIds } : {}) }), 'notice.promise'),
        onReady: (reason) => void write(() => markReady(api, orderId, { version: version(), reason }), 'notice.ready'),
        onClose: (reason) => void write(() => closeOrder(api, orderId, { version: version(), ...(reason ? { reason } : {}) }), 'notice.closed'),
        onSendLink: (requestId, message) =>
          void write(
            async () => {
              setSentLink(await sendDepositLink(api, requestId, message))
              return null
            },
            null,
            true,
          ),
        onRecordPayment: (requestId, input) => {
          // One key for the write and its repeat after the code: the API answers the second from its receipt.
          const key = newIdempotencyKey()
          const body = { depositRequestId: requestId, amount: input.amount, receivedOn: input.receivedOn, externalRef: input.reference, internalNote: input.note || null, issueDepositInvoice: input.issue }
          void write(
            async () => {
              if (input.issue) await ensureFresh('stepUp.sentence.td02')
              setRecorded(await guard('stepUp.sentence.td02', () => recordDepositPayment(api, body, key)))
              return null
            },
            null,
            true,
          )
        },
        onSendSdi: (invoiceId) => {
          const key = newIdempotencyKey()
          void write(
            async () => {
              const before = sdi?.[invoiceId]?.value ?? (await getSdi(api, invoiceId))
              await ensureFresh('stepUp.sentence.sdi')
              const answer = await guard('stepUp.sentence.sdi', () => sendToSdi(api, invoiceId, before.version, key))
              setSdi((known) => ({ ...(known ?? {}), [invoiceId]: part(answer) }))
              return null
            },
            'notice.sdiSent',
          )
        },
        onSizeLayer: setSizeLayer,
        // ---- B-W2a-50 ----------------------------------------------------------------------------------------------------
        onAmendStart: startAmend,
        onAmendDiscard: () => {
          setAmend(null)
          setChanged(null)
        },
        onAmendCells: (styleId, next) => setAmend((known) => (known ? { ...known, lines: withCells(known.lines, Object.fromEntries(Object.entries(next).filter(([key]) => known.lines.some((line) => line.key === key && line.styleId === styleId)))) } : known)),
        onAmendPrice: (key, text) => setAmend((known) => (known ? { ...known, lines: known.lines.map((line) => (line.key === key ? { ...line, price: text } : line)) } : known)),
        onAmendHeader: (field, text) => setAmend((known) => (known ? { ...known, [field]: text } : known)),
        onAmendReview: review,
        onAmendApply: (reason) => {
          const draft = amendRef.current
          if (!draft) return
          const key = newIdempotencyKey()
          void write(async () => {
            const value = current.current!
            const answer = await applyAmendment(api, orderId, { version: value.version, reason, ...amendBody(draft, value) }, key)
            setAmend(null)
            setChanged(null)
            setNotice({ tone: 'success', words: { key: answer.amendment.reacceptance === 'NEEDED' ? 'notice.amendedReaccept' : 'notice.amended', params: { revision: answer.amendment.revision } } })
            return answer.order
          }, null)
        },
        onComposerQuery: composerQuery,
        onComposerPick: composerPick,
        onComposerToggle: (colourwayId) => setAmend((known) => (known ? { ...known, composer: { ...known.composer, picked: known.composer.picked.includes(colourwayId) ? known.composer.picked.filter((id) => id !== colourwayId) : [...known.composer.picked, colourwayId] } } : known)),
        onComposerAdd: composerAdd,
        onCloseLines: (lineIds, reason) =>
          void write(
            async () => {
              const answer = await closeLines(api, orderId, { version: version(), reason, ...(lineIds.length > 0 ? { lineIds } : {}) })
              setClosedLines(answer)
              return answer.order
            },
            null,
            true,
          ),
        onReopenLines: (lineIds, reason) => void write(async () => (await reopenLines(api, orderId, { version: version(), reason, ...(lineIds.length > 0 ? { lineIds } : {}) })).order, 'notice.reopened'),
        onCancelOrder: (reason, typed) => void write(async () => (await cancelOrder(api, orderId, { version: version(), reason, confirmNumber: typed })).order, 'notice.cancelled'),
        onCopyAsQuote: () =>
          void write(
            async () => {
              setCopied(await copyAsQuote(api, orderId))
              return null
            },
            null,
            true,
          ),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
