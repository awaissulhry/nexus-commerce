'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { depositReceived, findCustomers, getInvoice, listPayments, openItems, recordPayment, type PaymentQuery, type PaymentRow } from '../../_shared/api'
import { downloadText, isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { abilitiesOf, allocationsOf, money, paymentsCsv, paymentsTouched, placedLabel, readProblem, romeToday, writeProblem } from '../../_shared/model'
import { cancelRefund, listRefunds, openRefunds as readOpenRefunds, payRefund, recordRefund, voidRefund, type OpenRefunds, type Refund } from '../refunds/api'
import { refundAbilitiesOf, refundAskOf, refundRowsFrom, refundRowsOf, refundsCsv, refundsTouched, settlesWords, targetOfNote, type RefundMove, type RefundRow, type RefundRows } from '../refunds/model'
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
    <WithMessages namespaces={['finance', 'finance-daily', 'lists']}>
      <PaymentsContainer />
    </WithMessages>
  )
}

const TILE_LIMIT = 200
const rowsOf = (value: string | null): PaymentRowsView => ((PAYMENT_ROWS_VIEWS as readonly string[]).includes(value ?? '') ? (value as PaymentRowsView) : 'all')
const queryOf = (rows: PaymentRowsView): PaymentQuery => (rows === 'received' ? { status: 'RECEIVED' } : rows === 'voided' ? { status: 'VOIDED' } : {})
const REFUND_PAGE = 50

function PaymentsContainer() {
  const t = useT('finance')
  const d = useT('finance-daily')
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
  // B-W2a-80: refunds — the tile, the rows view (`?rows=refunds&refunds=open|due|paid|closed|all`), the dialogs.
  const refundCan = useMemo(() => refundAbilitiesOf(session.permissions), [session.permissions])
  const refundRows: RefundRows = refundRowsOf(params?.get('refunds'))
  const refundStart = params?.get('refund') ?? null
  const [openRefunds, setOpenRefunds] = useState<OpenRefunds | null>(null)
  const [openProblem, setOpenProblem] = useState<string | null>(null)
  const [refundList, setRefundList] = useState<{ items: Refund[] | null; more: boolean; problem: string | null; cursor: string | null }>({ items: null, more: false, problem: null, cursor: null })
  const [refundDialog, setRefundDialog] = useState<{ start: string | null } | null>(refundStart ? { start: refundStart } : null)
  const [refundMove, setRefundMove] = useState<{ refund: Refund; move: RefundMove } | null>(null)
  const [refundProblem, setRefundProblem] = useState<PaymentsListModel['dialogProblem']>(null)

  const readOpen = useCallback(async () => {
    if (!refundCan.view) return
    try {
      setOpenRefunds(await readOpenRefunds(api))
      setOpenProblem(null)
    } catch (error) {
      setOpenRefunds(null)
      setOpenProblem(readProblem(error))
    }
  }, [api, refundCan.view])

  const readRefunds = useCallback(async () => {
    if (rows !== 'refunds' || refundRows === 'open') return
    setRefundList({ items: null, more: false, problem: null, cursor: null })
    try {
      const page = await listRefunds(api, { view: refundRows, limit: REFUND_PAGE })
      setRefundList({ items: page.refunds, more: page.nextCursor !== null, problem: null, cursor: page.nextCursor })
    } catch (error) {
      setRefundList({ items: null, more: false, problem: readProblem(error), cursor: null })
    }
  }, [api, rows, refundRows])

  useEffect(() => {
    void readOpen()
  }, [readOpen])
  useEffect(() => {
    void readRefunds()
  }, [readRefunds])

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
    if (rows === 'refunds') return
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
  const rereadRefunds = useCoalesced(() => {
    void readOpen()
    void readRefunds()
  }, 800)
  const live = useLive(
    (change) => {
      if (refundsTouched(change)) rereadRefunds()
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

  const refundItems: RefundRow[] | null = refundRowsFrom(refundRows, openRefunds, refundList.items)
  const refunds: PaymentsListModel['refunds'] =
    rows === 'refunds'
      ? { prefix, can: refundCan, rows: refundRows, items: refundItems, problem: refundRows === 'open' ? openProblem : refundList.problem, more: refundRows === 'open' ? false : refundList.more }
      : null

  const refundTargets = openRefunds ? openRefunds.creditNotesToRefund.map(targetOfNote) : openProblem ? [] : null
  const model: PaymentsListModel = {
    prefix,
    can,
    today: romeToday(),
    companyId,
    rows,
    list,
    tiles,
    asOf,
    live,
    updates,
    notice,
    dialog,
    customers,
    items,
    recorded,
    busy,
    dialogProblem,
    stepUp,
    refundCan,
    openRefunds,
    refunds,
    refundDialog: refundDialog ? { targets: refundTargets, targetsProblem: openProblem, start: refundDialog.start, can: refundCan, today: romeToday(), busy, problem: refundProblem } : null,
    refundMove: refundMove ? { ...refundMove, busy, problem: refundProblem } : null,
  }

  const refundWrite = async (run: () => Promise<Refund>, words: (refund: Refund) => NonNullable<PaymentsListModel['notice']>) => {
    if (busy) return
    setBusy(true)
    setRefundProblem(null)
    try {
      const refund = await run()
      setRefundDialog(null)
      setRefundMove(null)
      setNotice(words(refund))
      void readOpen()
      void readRefunds()
      void readTiles()
    } catch (error) {
      setRefundProblem(writeProblem(error))
      void readOpen()
    } finally {
      setBusy(false)
    }
  }
  const dropRefundParam = () => {
    if (!params?.get('refund')) return
    const search = new URLSearchParams(params.toString())
    search.delete('refund')
    const text = search.toString()
    router.replace(text ? `${pathname}?${text}` : pathname)
  }

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
        onRefundRows: (next) => router.replace(next === 'open' ? `${pathname}?rows=refunds` : `${pathname}?rows=refunds&refunds=${next}`),
        onRefundMore: () => {
          if (!refundList.cursor || refundRows === 'open') return
          void (async () => {
            try {
              const page = await listRefunds(api, { view: refundRows, cursor: refundList.cursor, limit: REFUND_PAGE })
              setRefundList((current) => ({ items: [...(current.items ?? []), ...page.refunds.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null, cursor: page.nextCursor }))
            } catch (error) {
              setNotice({ tone: 'danger', words: { key: readProblem(error) } })
            }
          })()
        },
        onRetryRefunds: () => {
          void readOpen()
          void readRefunds()
        },
        onOpenRefund: (note) => {
          setRefundProblem(null)
          setRefundDialog({ start: note?.creditNoteId ?? null })
          void readOpen()
        },
        onRecordRefund: (target, draft) => {
          const key = newIdempotencyKey()
          void refundWrite(
            () => recordRefund(api, refundAskOf(target, draft), key),
            (refund) => ({ tone: 'success', words: { key: refund.status === 'PAID' ? 'notice.refundPaid' : 'notice.refundDue', params: { amount: money(refund.amount, refund.currency, locale), customer: refund.party.legalName } } }),
          ).then(dropRefundParam)
        },
        onCloseRefund: () => {
          setRefundDialog(null)
          setRefundProblem(null)
          dropRefundParam()
        },
        onMoveRefund: (refund, move) => {
          setRefundProblem(null)
          setRefundMove({ refund, move })
        },
        onDoMove: (input) => {
          const current = refundMove
          if (!current) return
          const key = newIdempotencyKey()
          const run = current.move === 'paid' ? () => payRefund(api, current.refund, { paidOn: input.paidOn, externalRef: input.reference }, key) : current.move === 'cancel' ? () => cancelRefund(api, current.refund, input.reason, key) : () => voidRefund(api, current.refund, input.reason, key)
          void refundWrite(run, () => ({ tone: 'success', words: { key: `notice.refundMoved.${current.move}` } }))
        },
        onCloseMove: () => {
          setRefundMove(null)
          setRefundProblem(null)
        },
        onExportRefunds: (ids) => {
          const picked = (refundItems ?? []).filter((row) => ids.includes(row.id))
          downloadText(
            `refunds-${romeToday()}.csv`,
            refundsCsv(
              picked,
              can.price,
              {
                header: (column) => d(`refunds.csv.${column}`),
                state: (row) => (row.kind === 'toRefund' ? d('refunds.state.toRefund') : d(`refunds.state.${row.refund.status}`)),
                settles: (row) => {
                  if (row.kind === 'toRefund') return d('refunds.creditNote', { number: row.note.number ?? '—' })
                  const words = settlesWords(row.refund)
                  return d(words.key, words.params)
                },
              },
              locale,
            ),
          )
        },
      }}
    />
  )
}
