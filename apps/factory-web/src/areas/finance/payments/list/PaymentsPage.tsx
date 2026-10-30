'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { depositReceived, findCustomers, getInvoice, listPayments, openItems, recordPayment, type PaymentQuery, type PaymentRow } from '../../_shared/api'
import { downloadText, isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { abilitiesOf, allocationsOf, paymentsCsv, paymentsTouched, placedLabel, readProblem, romeToday, writeProblem } from '../../_shared/model'
import { PAYMENT_ROWS_VIEWS, type PaymentRowsView, type PaymentsListModel, type PickedCustomer, type RecordInput } from './list-model'
import { PaymentsListView } from './view/PaymentsListView'

/**
 * `/w/<company>/finance/payments` (SCR-082): reads the payments (50 a page with "Show more"; `?rows=received|voided`),
 * the tiles (money in this month and what is not placed yet, from the latest 200), keeps them live (a payment recorded,
 * placed or taken back: rows wait behind "N updates · Show"), and records a payment: the customer (search), then their
 * open items, then ONE write — `POST /payments` with its placements, or, when it pays one deposit request, "deposit
 * received" with its TD02 (a fresh authenticator code first). `?new=1&invoice=<id>` opens it with that invoice chosen.
 */
export function PaymentsPage() {
  return (
    <WithMessages namespaces={['finance', 'lists']}>
      <PaymentsContainer />
    </WithMessages>
  )
}

const TILE_LIMIT = 200
const rowsOf = (value: string | null): PaymentRowsView => ((PAYMENT_ROWS_VIEWS as readonly string[]).includes(value ?? '') ? (value as PaymentRowsView) : 'all')
const queryOf = (rows: PaymentRowsView): PaymentQuery => (rows === 'received' ? { status: 'RECEIVED' } : rows === 'voided' ? { status: 'VOIDED' } : {})

function PaymentsContainer() {
  const t = useT('finance')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/finance\/payments\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const rows = rowsOf(params?.get('rows') ?? null)
  const companyId = session.company?.id ?? null

  const [list, setList] = useState<PaymentsListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<PaymentsListModel['tiles']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<PaymentsListModel['notice']>(null)
  const [dialog, setDialog] = useState<PaymentsListModel['dialog']>(null)
  const [customers, setCustomers] = useState<PaymentsListModel['customers']>({ q: '', items: null, problem: null })
  const [items, setItems] = useState<PaymentsListModel['items']>({ value: null, problem: null })
  const [recorded, setRecorded] = useState<PaymentsListModel['recorded']>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<PaymentsListModel['dialogProblem']>(null)
  const readId = useRef(0)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)

  const readTiles = useCallback(async () => {
    try {
      const page = await listPayments(api, { status: 'RECEIVED', limit: TILE_LIMIT })
      const month = romeToday().slice(0, 7)
      const inMonth = page.payments.filter((row) => row.receivedOn.startsWith(month))
      const notPlaced = page.payments.filter((row) => (row.unallocated ?? 0) > 0)
      const sum = (entries: PaymentRow[], field: 'amount' | 'unallocated') => (can.price ? entries.reduce((total, row) => total + (row[field] ?? 0), 0) : null)
      setTiles({ monthCount: inMonth.length, monthAmount: sum(inMonth, 'amount'), notPlacedCount: notPlaced.length, notPlacedAmount: sum(notPlaced, 'unallocated'), capped: page.nextCursor !== null })
    } catch {
      setTiles(null)
    }
  }, [api, can.price])

  const load = useCallback(async () => {
    const id = ++readId.current
    void readTiles()
    setList((current) => ({ ...current, problem: null }))
    try {
      const page = await listPayments(api, queryOf(rows))
      if (id !== readId.current) return
      setList({ items: page.payments, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, rows, readTiles])

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listPayments(api, { ...queryOf(rows), cursor })
      setList((current) => ({ items: [...(current.items ?? []), ...page.payments.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, rows])

  const recount = useCoalesced(() => void readTiles(), 800)
  const live = useLive(
    (change) => {
      if (!paymentsTouched(change)) return
      if (change.type.startsWith('payment.')) setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  const searchCustomers = useCallback(
    async (q: string) => {
      setCustomers({ q, items: null, problem: null })
      try {
        setCustomers({ q, items: await findCustomers(api, q, companyId), problem: null })
      } catch (error) {
        setCustomers({ q, items: null, problem: readProblem(error) })
      }
    },
    [api, companyId],
  )

  const readItems = useCallback(
    async (customer: PickedCustomer) => {
      setItems({ value: null, problem: null })
      try {
        setItems({ value: await openItems(api, customer.companyId, customer.id), problem: null })
      } catch (error) {
        setItems({ value: null, problem: readProblem(error) })
      }
    },
    [api],
  )

  // `?new=1` (and `&invoice=<id>`): Record payment opens; from an invoice, its customer and company are chosen.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || params?.get('new') !== '1' || !can.recordPayments) return
    opened.current = true
    const invoiceId = params.get('invoice')
    if (!invoiceId) {
      setDialog({ kind: 'record', step: 1, customer: null, invoiceId: null })
      void searchCustomers('')
      return
    }
    void (async () => {
      try {
        const invoice = await getInvoice(api, invoiceId)
        const customer = { id: invoice.buyerPartyId, name: invoice.party.legalName, companyId: invoice.companyId }
        setDialog({ kind: 'record', step: 1, customer, invoiceId })
        void readItems(customer)
      } catch {
        setDialog({ kind: 'record', step: 1, customer: null, invoiceId: null })
        void searchCustomers('')
      }
    })()
  }, [params, can.recordPayments, api, readItems, searchCustomers])

  const record = useCallback(
    async (input: RecordInput) => {
      if (busy) return
      setBusy(true)
      setDialogProblem(null)
      const key = newIdempotencyKey()
      try {
        const allocations = allocationsOf(items.value ?? [], input.plan)
        const only = allocations.length === 1 ? allocations[0]! : null
        const request = only?.depositRequestId ? (items.value ?? []).find((item) => item.id === only.depositRequestId) : null
        // One deposit request it pays in full (or up to what the payment holds): "deposit received", with its TD02.
        if (request && only && only.amount === Math.min(input.amount, request.openAmount ?? input.amount)) {
          const body = { depositRequestId: request.id, amount: input.amount, receivedOn: input.receivedOn, externalRef: input.reference, internalNote: input.note || null, issueDepositInvoice: input.issueDepositInvoice }
          if (input.issueDepositInvoice) await ensureFresh('stepUp.sentence.td02')
          const answer = await guard('stepUp.sentence.td02', () => depositReceived(api, body, key))
          setRecorded({ payment: answer.payment, depositInvoice: { required: answer.depositInvoice.required, number: answer.depositInvoice.invoice?.number ?? null, filesPending: answer.depositInvoice.filesPending } })
        } else {
          const payment = await recordPayment(api, { companyId: input.customer.companyId, partyId: input.customer.id, amount: input.amount, receivedOn: input.receivedOn, externalRef: input.reference, internalNote: input.note || null, allocations }, key)
          setRecorded({ payment, depositInvoice: null })
        }
        void load()
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const words = writeProblem(error)
        setDialogProblem(words)
        if (words.reload && dialog?.customer) void readItems(dialog.customer)
      } finally {
        setBusy(false)
      }
    },
    [api, busy, items.value, ensureFresh, guard, load, readItems, dialog],
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (list.items ?? []).filter((row) => ids.includes(row.id))
      downloadText(
        `payments-${romeToday()}.csv`,
        paymentsCsv(
          picked,
          can.price,
          {
            header: (column) => t(`csv.${column}`),
            status: (status) => t(`paymentStatus.${status}`),
            placed: (entry) => {
              const label = placedLabel(entry)
              return t(label.key, label.params)
            },
          },
          locale,
        ),
      )
    },
    [list.items, can.price, t, locale],
  )

  const model: PaymentsListModel = { prefix, can, today: romeToday(), companyId, rows, list, tiles, asOf, live, updates, notice, dialog, customers, items, recorded, busy, dialogProblem, stepUp }

  return (
    <PaymentsListView
      model={model}
      actions={{
        onRows: (next) => router.replace(next === 'all' ? pathname : `${pathname}?rows=${next}`),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/finance/payments/${id}`),
        onExport: exportRows,
        onDialog: (next) => {
          if (next && !dialog) {
            setRecorded(null)
            setItems({ value: null, problem: null })
            if (!next.customer) void searchCustomers('')
          }
          if (!next) setRecorded(null)
          setDialog(next)
          setDialogProblem(null)
        },
        onSearchCustomers: (q) => void searchCustomers(q),
        onPickCustomer: (customer) => {
          setDialog((current) => (current ? { ...current, customer } : current))
          void readItems(customer)
        },
        onRetryItems: () => dialog?.customer && void readItems(dialog.customer),
        onRecord: (input) => void record(input),
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
