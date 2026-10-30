'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { getSdi, invoiceFromDdts, listInvoices, shippedNotInvoiced, type InvoiceRow } from '../../_shared/api'
import { downloadText, useCoalesced, useLive } from '../../_shared/hooks'
import { abilitiesOf, invoicesAddress, invoicesCsv, invoicesTouched, queryFromAddress, readProblem, romeToday, writeProblem, type RowView } from '../../_shared/model'
import type { InvoicesListModel } from './list-model'
import { InvoicesListView } from './view/InvoicesListView'

/**
 * `/w/<company>/finance/invoices` (SCR-080): reads the invoices of the saved view or the filter the address names (the
 * API's own: `?status=REJECTED`, `?docType=TD04` — Home › Today's links land here), 50 a page with "Show more" (cursor),
 * the tiles (one read per tile, each up to 200), the rejected invoices with their SDI deadline, and the DDTs shipped and
 * not invoiced; keeps them live (an invoice issued, sent, delivered or rejected, a payment placed, goods shipped: rows
 * wait behind "N updates · Show", the tiles and the shipped list follow at once). "Invoice shipped goods" makes one draft
 * from DDTs and opens it. Export N = CSV of the selected rows.
 */
export function InvoicesPage() {
  return (
    <WithMessages namespaces={['finance', 'lists']}>
      <InvoicesContainer />
    </WithMessages>
  )
}

const TILE_LIMIT = 200

function InvoicesContainer() {
  const t = useT('finance')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/finance\/invoices\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const { rows, query } = queryFromAddress(params)
  const queryKey = `${query.status ?? ''}|${query.docType ?? ''}`

  const [list, setList] = useState<InvoicesListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<InvoicesListModel['tiles']>(null)
  const [queue, setQueue] = useState<InvoicesListModel['queue']>({ value: null, problem: null })
  const [rejected, setRejected] = useState<InvoicesListModel['rejected']>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<InvoicesListModel['notice']>(null)
  const [dialog, setDialog] = useState<InvoicesListModel['dialog']>(params?.get('new') === '1' ? { kind: 'fromDdts', ddtIds: [], partyId: null } : null)
  const [dialogProblem, setDialogProblem] = useState<InvoicesListModel['dialogProblem']>(null)
  const [busy, setBusy] = useState(false)
  const readId = useRef(0)

  const readTiles = useCallback(async () => {
    try {
      const [drafts, atSdi, rejectedPage, notDelivered] = await Promise.all(
        (['DRAFT', 'SENT', 'REJECTED', 'NOT_DELIVERABLE'] as const).map((status) => listInvoices(api, { status, limit: TILE_LIMIT })),
      )
      setTiles({ drafts: drafts!.invoices.length, atSdi: atSdi!.invoices.length, rejected: rejectedPage!.invoices.length, notDelivered: notDelivered!.invoices.length })
      // The rejected notice: the newest three with SDI's deadline to send them again (one read each).
      const shown = rejectedPage!.invoices.slice(0, 3)
      const withDeadline = await Promise.all(
        shown.map(async (row) => {
          try {
            const sdi = await getSdi(api, row.id)
            return { id: row.id, number: row.number, partyName: row.partyName, deadline: sdi.deadline?.deadline ?? null, overdue: sdi.deadline?.overdue ?? false }
          } catch {
            return { id: row.id, number: row.number, partyName: row.partyName, deadline: null, overdue: false }
          }
        }),
      )
      setRejected(withDeadline)
    } catch {
      setTiles(null)
    }
  }, [api])

  const readQueue = useCallback(async () => {
    try {
      setQueue({ value: await shippedNotInvoiced(api), problem: null })
    } catch (error) {
      setQueue({ value: null, problem: readProblem(error) })
    }
  }, [api])

  const load = useCallback(async () => {
    const id = ++readId.current
    void readTiles()
    void readQueue()
    setList((current) => ({ ...current, problem: null }))
    try {
      const page = await listInvoices(api, query)
      if (id !== readId.current) return
      setList({ items: page.invoices, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, queryKey, readTiles, readQueue])

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listInvoices(api, { ...query, cursor })
      setList((current) => ({ items: [...(current.items ?? []), ...page.invoices.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, queryKey])

  // Live: an invoice or payment event, goods shipped → "N updates · Show"; the tiles and the shipped list follow at once.
  const recount = useCoalesced(() => {
    void readTiles()
    void readQueue()
  }, 800)
  const live = useLive(
    (change) => {
      if (!invoicesTouched(change)) return
      if (change.type.startsWith('invoice.') || change.type.startsWith('payment.')) setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (list.items ?? []).filter((row: InvoiceRow) => ids.includes(row.id))
      downloadText(`invoices-${romeToday()}.csv`, invoicesCsv(picked, can.price, { header: (column) => t(`csv.${column}`), docType: (docType) => t(`docType.${docType}`), status: (status) => t(`invoiceStatus.${status}`) }, locale))
    },
    [list.items, can.price, t, locale],
  )

  const create = useCallback(
    async (input: { ddtIds: string[]; docType: 'TD01' | 'TD24' }) => {
      if (busy) return
      setBusy(true)
      setDialogProblem(null)
      try {
        const answer = await invoiceFromDdts(api, input, newIdempotencyKey())
        setDialog(null)
        router.push(`${prefix}/finance/invoices/${answer.invoice.id}?tab=lines`)
      } catch (error) {
        const words = writeProblem(error)
        setDialogProblem(words)
        if (words.reload) void readQueue()
      } finally {
        setBusy(false)
      }
    },
    [api, busy, prefix, router, readQueue],
  )

  const model: InvoicesListModel = { prefix, can, today: romeToday(), rows, query, list, tiles, queue, rejected, asOf, live, updates, notice, dialog, dialogProblem, busy }

  return (
    <InvoicesListView
      model={model}
      actions={{
        onRows: (next: RowView) => router.replace(invoicesAddress(pathname, next)),
        onMore: () => void more(),
        onRetry: () => void load(),
        onRetryQueue: () => void readQueue(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/finance/invoices/${id}`),
        onExport: exportRows,
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onCreateFromDdts: (input) => void create(input),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

