'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { buyingCan, csvOf, part, phrase, readProblem, startOfDayIn, type Part } from '../../../_shared/buying/model'
import { EVERY_COMPANY, useSheetImport } from '../../../products/styles/import/sheet-import'
import { hideListSummary, type HideListSummary } from '../daily-api'
import { dailyCan, hideListHeld, NAMESPACE, readSay } from '../daily-model'
import { countReceipts, expectedLines, listReceipts, type ReceiptCounts } from '../api'
import { receiptQuery, receiptViewOf, type ReceiptsListModel, type ReceiptView } from '../model'
import { ReceiptsListView } from './view/ReceiptsListView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/warehouse/receipts` (SCR-063): the view (`?view=expected|posted|today|waiting|reversed|all`, the API's
 * `?status=` too) and the search (`?q=`) in the address; the receipts 50 a page with "Show more", the order lines still
 * to receive (inventory.receive), the tiles' counts, and live inventory.receipt_* and purchase_order.* events behind
 * "N updates · Show". Receive opens the receiving page (`/warehouse/receipts/new?order=…`).
 */
export function ReceiptsPage() {
  return (
    <WithMessages namespaces={['buying', 'lists', NAMESPACE, 'admin-import', 'admin']}>
      <ReceiptsContainer />
    </WithMessages>
  )
}

function ReceiptsContainer() {
  const t = useT('buying')
  const td = useT(NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/receipts\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])
  const view = receiptViewOf(params, can.receive)
  const q = params?.get('q') ?? ''
  const postedFrom = useMemo(() => startOfDayIn(TIME_ZONE), [])

  const [rows, setRows] = useState<ReceiptsListModel['rows']>({ items: null, more: false, problem: null })
  const [expected, setExpected] = useState<ReceiptsListModel['expected']>({ items: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<ReceiptCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<ReceiptsListModel['notice']>(null)
  const readId = useRef(0)

  const address = useCallback(
    (next: { view?: ReceiptView; q?: string }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      return `${pathname}?${query.toString()}`
    },
    [pathname, view, q],
  )

  const loadCounts = useCallback(() => {
    countReceipts(api, postedFrom)
      .then(setCounts)
      .catch(() => setCounts(null))
  }, [api, postedFrom])

  const loadExpected = useCallback(() => {
    if (!can.receive) return
    expectedLines(api, {})
      .then((items) => setExpected({ items, problem: null }))
      .catch((error: unknown) => setExpected({ items: null, problem: readProblem(error) }))
  }, [api, can.receive])

  const load = useCallback(async () => {
    if (!can.stockView) return
    const id = ++readId.current
    loadCounts()
    loadExpected()
    if (view === 'expected') {
      setAsOf(new Date().toISOString())
      setUpdates(0)
      return
    }
    try {
      const page = await listReceipts(api, receiptQuery(view, q, postedFrom))
      if (id !== readId.current) return
      setRows({ items: page.receipts, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.stockView, view, q, postedFrom, loadCounts, loadExpected])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listReceipts(api, receiptQuery(view, q, postedFrom, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.receipts.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: phrase(readProblem(error)) })
    }
  }, [api, cursor, view, q, postedFrom])

  // Live: a receipt posted or reversed, or an order's state moved: the tiles and the expected lines follow at once, the
  // receipts wait behind "N updates · Show" (rows never move under the cursor).
  const refresh = useCoalesced(() => {
    loadCounts()
    loadExpected()
  }, 800)
  const live = useLive(
    (change) => {
      if (change.type.startsWith('inventory.receipt_')) {
        setUpdates((count) => count + 1)
        refresh()
      } else if (change.type.startsWith('purchase_order.')) refresh()
    },
    () => void load(),
    can.stockView,
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['number', 'status', 'supplier', 'order', 'ddt', 'ddtDate', 'receivedAt', 'lines', 'lots', 'released', 'hides', 'quantity', ...(can.cost ? ['value', 'currency'] : [])].map((column) => t(`rc.csv.${column}`))
      const csvRows = picked.map((row) => [
        row.number,
        t(`rcStatus.${row.status}`),
        row.supplier.name,
        row.purchaseOrder?.number ?? '',
        row.supplierDdtNumber ?? '',
        row.supplierDdtDate ?? '',
        row.receivedAt,
        row.lines,
        row.lots,
        row.lotsReleased,
        row.hides,
        row.quantities.map((entry) => `${entry.baseQuantity} ${entry.uom}`).join(' + '),
        ...(can.cost ? [row.value ? (row.value.valueAmount / 100).toFixed(2) : '', row.value?.currency ?? ''] : []),
      ])
      downloadText(`receipts-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [rows.items, can.cost, t],
  )

  // ---- B-W2a-63: the tannery's hide list (importer inventory.hideList; one list = one order = ONE receipt) ----
  const dCan = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const sheet = useSheetImport(api, {
    importerKey: 'inventory.hideList',
    // A hide list is received by the order's company: the address's company (the API refuses "every company").
    companyId: session.company?.id ?? EVERY_COMPANY,
    companies,
    everyCompany: td('hideList.everyCompany'),
    rights: { view: dCan.importView, run: dCan.importRun, apply: dCan.importApply, people: false },
    locale: locale === 'en' ? 'en' : 'it',
    onApplied: () => void load(),
  })
  const jobId = sheet.model?.wizard.job?.id ?? null
  const [importId, setImportId] = useState<string | null>(null)
  const [summary, setSummary] = useState<Part<HideListSummary>>({ value: null, problem: null })
  useEffect(() => {
    if (jobId) setImportId(jobId)
  }, [jobId])
  const wizardOpen = sheet.model !== null
  const loadSummary = useCallback(() => {
    if (!importId) return
    setSummary({ value: null, problem: null })
    hideListSummary(api, importId)
      .then((value) => setSummary(part(value)))
      .catch((error: unknown) => setSummary({ value: null, problem: readSay(error) }))
  }, [api, importId])
  useEffect(() => {
    if (!wizardOpen) loadSummary()
  }, [wizardOpen, loadSummary])

  const model: ReceiptsListModel = {
    prefix,
    can,
    view,
    q,
    rows,
    expected,
    counts,
    asOf,
    live,
    updates,
    notice,
    timeZone: TIME_ZONE,
    hideList: { held: hideListHeld(dCan), sheet: sheet.model, summary: importId && !wizardOpen ? { importId, part: summary } : null },
  }

  return (
    <ReceiptsListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => router.replace(address({ q: next })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/receipts/${id}`),
        onReceive: (orderId, lineIds) => {
          const query = new URLSearchParams()
          if (orderId) query.set('order', orderId)
          if (orderId && lineIds && lineIds.length > 0) query.set('lines', lineIds.join(','))
          const qs = query.toString()
          router.push(`${prefix}/warehouse/receipts/new${qs ? `?${qs}` : ''}`)
        },
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        hideList: {
          onOpen: () => {
            if (!hideListHeld(dCan)) sheet.open()
          },
          wizard: sheet.actions,
          onRetrySummary: loadSummary,
          onDismiss: () => setImportId(null),
        },
      }}
    />
  )
}
