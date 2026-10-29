'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { listVersions, type VersionsAnswer } from '../../quotes/api'
import {
  changePromise,
  closeOrder,
  getOrder,
  getSdi,
  getSettlement,
  listOrderWorkOrders,
  markReady,
  recordDepositPayment,
  sendDepositLink,
  sendToSdi,
  type DepositLinkAnswer,
  type DepositReceived,
  type Order,
  type OrderWorkOrder,
  type SdiStatus,
  type Settlement,
} from '../api'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp, useThreadDock } from '../hooks'
import { abilitiesOf, knownIds, liveTouches, readProblem, romeToday, tabOf, writeProblem, type SizeLayer } from '../model'
import { PART_LOADING, type Loaded, type OrderRecordModel, type Part, type RecordDialog } from './record-model'
import { OrderRecordView } from './view/OrderRecordView'

/**
 * `/w/<company>/sales/orders/<id>` (SCR-039): loads the order (orders.view; the API checks its company and customer),
 * and the parts its tabs show by the person's rights — its work orders with their floor progress (workorders.view), the
 * settlement and each issued invoice's SDI state (invoices.view), the quote's acceptance evidence (quotes.view) — and
 * does what the view asks, one write at a time, each with the order's version as read (a 409 reads it again and says
 * so): a new promise, ready by hand, close; the deposit's bank-details page, the payment (with the TD02: a fresh
 * authenticator code), the TD02's send to SDI. Live: events that name the order or a record of its chain read it again.
 */
export function OrderRecord({ orderId }: { orderId: string }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists', 'records']}>
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
      if (open && open.kind !== 'depositLink' && open.kind !== 'depositPayment') setChanged({ at: new Date().toISOString() })
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
  }

  const value = order.status === 'ready' ? order.value : null

  return (
    <OrderRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'SalesOrder', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.number} · ${value.party?.legalName ?? ''}`} party={value.party ? { id: value.partyId, name: value.party.legalName, emails: [] } : null} /> : null}
      actions={{
        onRetry: () => void load(),
        onRetryPart: () => value && loadParts(value),
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          setSentLink(null)
          setRecorded(null)
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
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
