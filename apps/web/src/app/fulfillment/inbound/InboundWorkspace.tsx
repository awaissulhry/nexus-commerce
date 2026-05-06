'use client'

// FULFILLMENT — Inbound H.3.
// Two lanes: WAREHOUSE (suppliers + manufacturing + transfers) and FBA
// (Send-to-Amazon end-to-end). Both share the InboundShipment model
// post-H.1+H.2 so the audit trail + discrepancy + cost surface is
// unified across types.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  PackageCheck, Plus, RefreshCw, Truck, X, Search,
  ArrowDownToLine, ChevronRight,
  Boxes, AlertTriangle, CalendarClock,
  FileText, ChevronUp, ChevronDown,
  Upload, Link2, Trash2, Camera, Unlock, History, Check,
  Smartphone,
} from 'lucide-react'
import Link from 'next/link'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type InboundType = 'FBA' | 'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'
type InboundStatus =
  | 'DRAFT' | 'SUBMITTED' | 'IN_TRANSIT' | 'ARRIVED' | 'RECEIVING'
  | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'RECONCILED' | 'CLOSED' | 'CANCELLED'

type Inbound = {
  id: string
  type: InboundType
  status: InboundStatus
  reference: string | null
  warehouseId: string | null
  fbaShipmentId: string | null
  purchaseOrderId: string | null
  workOrderId: string | null
  asnNumber: string | null
  asnFileUrl: string | null
  carrierCode: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  currencyCode: string
  shippingCostCents: number | null
  expectedAt: string | null
  arrivedAt: string | null
  closedAt: string | null
  notes: string | null
  warehouse?: { code: string; name: string } | null
  purchaseOrder?: { poNumber: string; supplierId: string | null } | null
  workOrder?: { id: string; productId: string; quantity: number } | null
  items: Array<{
    id: string
    sku: string
    productId: string | null
    quantityExpected: number
    quantityReceived: number
    qcStatus: string | null
  }>
  _count: { attachments: number; discrepancies: number }
  createdAt: string
}

type Kpis = {
  openShipments: number
  inTransit: number
  arrivingThisWeek: number
  delayed: number
  openDiscrepancies: number
  statusCounts: Record<string, number>
  typeCounts: Record<string, number>
}

const TYPE_TONE: Record<InboundType, string> = {
  FBA: 'bg-orange-50 text-orange-700 border-orange-200',
  SUPPLIER: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MANUFACTURING: 'bg-violet-50 text-violet-700 border-violet-200',
  TRANSFER: 'bg-blue-50 text-blue-700 border-blue-200',
}

const STATUS_VARIANT: Record<InboundStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default',
  SUBMITTED: 'info',
  IN_TRANSIT: 'info',
  ARRIVED: 'warning',
  RECEIVING: 'warning',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  RECONCILED: 'success',
  CLOSED: 'success',
  CANCELLED: 'default',
}

// Common Italian + international carrier tracking-URL templates.
// Frontend renders a hyperlink when carrierCode + trackingNumber are
// set and the carrier is in this map. Fallback: trackingUrl (operator-
// provided) or render the plain tracking number.
const CARRIER_TRACKING_URL: Record<string, (n: string) => string> = {
  BRT:    (n) => `https://www.brt.it/it/myBRT/Home/SpedizioniInArrivo?numericSearch=${encodeURIComponent(n)}`,
  POSTE:  (n) => `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${encodeURIComponent(n)}`,
  GLS:    (n) => `https://www.gls-italy.com/it/per-il-destinatario/segui-la-tua-spedizione?match=${encodeURIComponent(n)}`,
  SDA:    (n) => `https://www.sda.it/wps/portal/Servizi_online/RicercaSpedizioni?locale=it&tracing.letteraVettura=${encodeURIComponent(n)}`,
  TNT:    (n) => `https://www.tnt.com/express/it_it/site/shipping-tools/tracking.html?searchType=con&cons=${encodeURIComponent(n)}`,
  DHL:    (n) => `https://www.dhl.com/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}`,
  UPS:    (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  FEDEX:  (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  DSV:    (n) => `https://www.dsv.com/en/tracking?ref=${encodeURIComponent(n)}`,
}

const STATUS_OPTIONS: Array<{ value: InboundStatus | 'OPEN'; label: string }> = [
  { value: 'OPEN',               label: 'Open' },
  { value: 'DRAFT',              label: 'Draft' },
  { value: 'SUBMITTED',          label: 'Submitted' },
  { value: 'IN_TRANSIT',         label: 'In transit' },
  { value: 'ARRIVED',            label: 'Arrived' },
  { value: 'RECEIVING',          label: 'Receiving' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partial' },
  { value: 'RECEIVED',           label: 'Received' },
  { value: 'RECONCILED',         label: 'Reconciled' },
  { value: 'CLOSED',             label: 'Closed' },
  { value: 'CANCELLED',          label: 'Cancelled' },
]

const OPEN_STATUSES = 'DRAFT,SUBMITTED,IN_TRANSIT,ARRIVED,RECEIVING,PARTIALLY_RECEIVED,RECEIVED'

export default function InboundWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const tab = (searchParams.get('type') as 'ALL' | InboundType) ?? 'ALL'
  const status = searchParams.get('status') ?? ''
  const delayed = searchParams.get('delayed') === 'true'
  const search = searchParams.get('search') ?? ''
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const sortBy = searchParams.get('sortBy') ?? 'createdAt'
  const sortDir = (searchParams.get('sortDir') as 'asc' | 'desc') ?? 'desc'

  const [searchInput, setSearchInput] = useState(search)
  const [items, setItems] = useState<Inbound[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fbaWizardOpen, setFbaWizardOpen] = useState(false)
  const [bulkReceiveOpen, setBulkReceiveOpen] = useState(false)

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (tab !== 'ALL') qs.set('type', tab)
      // 'OPEN' expands to the multi-select of all in-flight statuses
      if (status === 'OPEN') qs.set('status', OPEN_STATUSES)
      else if (status) qs.set('status', status)
      if (delayed) qs.set('delayed', 'true')
      if (search) qs.set('search', search)
      qs.set('page', String(page))
      qs.set('pageSize', '50')
      qs.set('sortBy', sortBy)
      qs.set('sortDir', sortDir)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`inbound list failed: ${res.status}`)
      const data = await res.json()
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load inbound')
    } finally {
      setLoading(false)
    }
  }, [tab, status, delayed, search, page, sortBy, sortDir])

  const fetchKpis = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/kpis`, { cache: 'no-store' })
      if (res.ok) setKpis(await res.json())
    } catch { /* sidecar — best effort */ }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => { fetchKpis() }, [fetchKpis])

  // 30s poll
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') { fetchAll(); fetchKpis() }
    }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') { fetchAll(); fetchKpis() }
    }, 30000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(id) }
  }, [fetchAll, fetchKpis])

  const filterCount = useMemo(
    () => [tab !== 'ALL', status, delayed, search].filter(Boolean).length,
    [tab, status, delayed, search],
  )

  const toggleSort = (key: string) => {
    if (sortBy === key) {
      updateUrl({ sortDir: sortDir === 'asc' ? undefined : 'asc' })
    } else {
      updateUrl({ sortBy: key === 'createdAt' ? undefined : key, sortDir: undefined })
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbound Shipments"
        description="Receive from suppliers + manufacturing into the warehouse, or send to Amazon FBA end-to-end."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Inbound' }]}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button onClick={() => setBulkReceiveOpen(true)} className="h-8 px-3 text-[12px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5" title="Scan SKUs across any open shipment">
              <ArrowDownToLine size={12} /> Bulk receive
            </button>
            <button onClick={() => setFbaWizardOpen(true)} className="h-8 px-3 text-[12px] bg-orange-50 text-orange-700 border border-orange-200 rounded hover:bg-orange-100 inline-flex items-center gap-1.5">
              <Truck size={12} /> Send to Amazon FBA
            </button>
            <button onClick={() => setCreateOpen(true)} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
              <Plus size={12} /> New inbound
            </button>
            <button onClick={() => { fetchAll(); fetchKpis() }} className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {/* KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* H.10b — saved views bar. Shows up between KPIs and filters
          so the operator can switch into a known scope before they
          touch the filters. */}
      <SavedViewsBar
        currentFilters={{ type: tab === 'ALL' ? '' : tab, status, delayed: delayed ? 'true' : '', search, sortBy, sortDir }}
        onApply={(filters) => {
          // Replace all known filter keys at once. page resets implicitly.
          updateUrl({
            type: filters.type || undefined,
            status: filters.status || undefined,
            delayed: filters.delayed || undefined,
            search: filters.search || undefined,
            sortBy: filters.sortBy && filters.sortBy !== 'createdAt' ? filters.sortBy : undefined,
            sortDir: filters.sortDir && filters.sortDir !== 'desc' ? filters.sortDir : undefined,
            page: undefined,
          })
          setSearchInput(filters.search ?? '')
        }}
      />

      {/* Filter bar */}
      <Card>
        <div className="space-y-3">
          {/* Type tabs */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Type</span>
            {(['ALL', 'SUPPLIER', 'MANUFACTURING', 'TRANSFER', 'FBA'] as const).map((t) => {
              const active = tab === t
              return (
                <button
                  key={t}
                  onClick={() => updateUrl({ type: t === 'ALL' ? undefined : t, page: undefined })}
                  className={`h-7 px-3 text-[11px] rounded-full font-medium border ${
                    active ? 'bg-slate-900 text-white border-slate-900'
                           : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {t === 'SUPPLIER' ? 'Suppliers' :
                   t === 'MANUFACTURING' ? 'In-house' :
                   t === 'FBA' ? 'To FBA' :
                   t === 'TRANSFER' ? 'Transfers' : 'All'}
                  {kpis?.typeCounts?.[t] != null && t !== 'ALL' && (
                    <span className={`ml-1.5 text-[10px] tabular-nums ${active ? 'text-slate-300' : 'text-slate-400'}`}>
                      {kpis.typeCounts[t]}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Search + status chips */}
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
            <div className="flex-1 min-w-[240px] max-w-md relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search reference, tracking, PO, SKU…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-7"
              />
            </div>
            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold ml-1">Status</span>
            <select
              value={status}
              onChange={(e) => updateUrl({ status: e.target.value || undefined, page: undefined })}
              className="h-7 px-2 text-[12px] border border-slate-200 rounded font-medium"
            >
              <option value="">All</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <button
              onClick={() => updateUrl({ delayed: delayed ? undefined : 'true', page: undefined })}
              className={`h-7 px-3 text-[11px] rounded-full font-medium border inline-flex items-center gap-1 ${
                delayed ? 'bg-rose-50 text-rose-700 border-rose-300'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
              title="Past expected arrival in non-terminal status"
            >
              <CalendarClock size={11} />
              Delayed
              {kpis?.delayed != null && kpis.delayed > 0 && (
                <span className={`ml-0.5 text-[10px] tabular-nums ${delayed ? 'text-rose-500' : 'text-slate-400'}`}>
                  {kpis.delayed}
                </span>
              )}
            </button>
            {filterCount > 0 && (
              <button
                onClick={() => updateUrl({ type: undefined, status: undefined, delayed: undefined, search: undefined, page: undefined })}
                className="h-7 px-2 text-[12px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <X size={12} /> Clear
              </button>
            )}
            <div className="ml-auto text-[12px] text-slate-500">
              <span className="font-semibold text-slate-700 tabular-nums">{total}</span> shipments
            </div>
          </div>
        </div>
      </Card>

      {/* Table */}
      {error ? (
        <Card><div className="text-[13px] text-rose-700 py-8 text-center">Failed to load: {error}</div></Card>
      ) : loading && items.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading inbound…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="No inbound shipments"
          description={filterCount > 0 ? 'Try clearing filters.' :
            tab === 'FBA' ? 'Use "Send to Amazon FBA" to plan a shipment.' :
            'Receipts from suppliers or manufacturing show up here.'}
          action={filterCount > 0
            ? { label: 'Clear filters', onClick: () => updateUrl({ type: undefined, status: undefined, delayed: undefined, search: undefined, page: undefined }) }
            : { label: 'New inbound', onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <SortableTh label="Type" sortKey="type" current={sortBy} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Status" sortKey="status" current={sortBy} dir={sortDir} onSort={toggleSort} />
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Source</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Carrier · tracking</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Items</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Progress</th>
                  <SortableTh label="ETA" sortKey="expectedAt" current={sortBy} dir={sortDir} onSort={toggleSort} align="right" />
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Flags</th>
                  <SortableTh label="Created" sortKey="createdAt" current={sortBy} dir={sortDir} onSort={toggleSort} align="right" />
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const totalExpected = it.items.reduce((n, i) => n + i.quantityExpected, 0)
                  const totalReceived = it.items.reduce((n, i) => n + i.quantityReceived, 0)
                  const pct = totalExpected > 0 ? Math.round((totalReceived / totalExpected) * 100) : 0
                  const eta = it.expectedAt ? new Date(it.expectedAt) : null
                  const isLate = eta && eta.getTime() < Date.now() && it.status !== 'RECEIVED' && it.status !== 'RECONCILED' && it.status !== 'CLOSED'
                  return (
                    <tr
                      key={it.id}
                      onClick={() => setDrawerId(it.id)}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2">
                        <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${TYPE_TONE[it.type]}`}>
                          {it.type}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS_VARIANT[it.status] ?? 'default'} size="sm">
                          {it.status.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-[13px] text-slate-900 truncate max-w-[200px]">
                          {it.fbaShipmentId ? `FBA · ${it.fbaShipmentId}` :
                           it.purchaseOrder?.poNumber ? `PO ${it.purchaseOrder.poNumber}` :
                           it.workOrder ? `Work order × ${it.workOrder.quantity}` :
                           it.reference ?? '—'}
                        </div>
                        {it.warehouse && (
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">→ {it.warehouse.code}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <CarrierLink carrierCode={it.carrierCode} trackingNumber={it.trackingNumber} trackingUrl={it.trackingUrl} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                        {it.items.length}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-2 justify-end">
                          <span className="text-[11px] tabular-nums text-slate-600">{totalReceived}/{totalExpected}</span>
                          <div className="w-16 h-1.5 bg-slate-100 rounded overflow-hidden">
                            <div
                              className={`h-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-[11px]">
                        {eta ? (
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            <span className={isLate ? 'text-rose-700 font-semibold' : 'text-slate-600'}>
                              {eta.toLocaleDateString('en-GB')}
                            </span>
                            {isLate && (() => {
                              const daysLate = Math.floor((Date.now() - eta.getTime()) / 86400_000)
                              return (
                                <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">
                                  {daysLate}d late
                                </span>
                              )
                            })()}
                          </div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1.5 justify-end">
                          {it._count.discrepancies > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded" title={`${it._count.discrepancies} discrepancy`}>
                              <AlertTriangle size={9} /> {it._count.discrepancies}
                            </span>
                          )}
                          {it._count.attachments > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded" title={`${it._count.attachments} attachment`}>
                              <FileText size={9} /> {it._count.attachments}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-[11px] text-slate-400 tabular-nums">
                        {new Date(it.createdAt).toLocaleDateString('en-GB')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <ChevronRight size={14} className="text-slate-400 inline" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-[12px] text-slate-500">
          <span>Page <span className="font-semibold text-slate-700 tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => updateUrl({ page: page <= 2 ? undefined : String(page - 1) })}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
            >Previous</button>
            <button
              onClick={() => updateUrl({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
            >Next</button>
          </div>
        </div>
      )}

      {drawerId && (
        <InboundDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={() => { fetchAll(); fetchKpis() }} />
      )}
      {createOpen && (
        <CreateInboundModal onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); fetchAll(); fetchKpis() }} />
      )}
      {fbaWizardOpen && (
        <FBAWizardModal onClose={() => setFbaWizardOpen(false)} onCreated={() => { setFbaWizardOpen(false); fetchAll(); fetchKpis() }} />
      )}
      {bulkReceiveOpen && (
        <BulkReceiveModal
          onClose={() => setBulkReceiveOpen(false)}
          onReceived={() => { fetchAll(); fetchKpis() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// KPI strip
// ─────────────────────────────────────────────────────────────────────
function KpiStrip({ kpis }: { kpis: Kpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}><div className="h-[68px] flex items-center justify-center text-[12px] text-slate-400">…</div></Card>
        ))}
      </div>
    )
  }
  const cards = [
    {
      icon: Boxes,
      label: 'Open shipments',
      value: kpis.openShipments.toLocaleString(),
      detail: `${kpis.statusCounts.DRAFT ?? 0} draft · ${kpis.statusCounts.RECEIVING ?? 0} receiving`,
      tone: kpis.openShipments > 0 ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: Truck,
      label: 'In transit',
      value: kpis.inTransit.toLocaleString(),
      detail: `${kpis.statusCounts.ARRIVED ?? 0} arrived awaiting receive`,
      tone: kpis.inTransit > 0 ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: CalendarClock,
      label: 'Delayed',
      value: kpis.delayed.toLocaleString(),
      detail: kpis.delayed > 0 ? 'Past expected arrival' : `${kpis.arrivingThisWeek} arriving in 7d`,
      tone: kpis.delayed > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: AlertTriangle,
      label: 'Open discrepancies',
      value: kpis.openDiscrepancies.toLocaleString(),
      detail: 'REPORTED + ACKNOWLEDGED',
      tone: kpis.openDiscrepancies > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-600',
    },
  ]
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <Card key={i}>
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 ${c.tone}`}>
              <c.icon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{c.label}</div>
              <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">{c.value}</div>
              <div className="text-[11px] text-slate-500 mt-0.5 truncate">{c.detail}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

function SortableTh({
  label, sortKey, current, dir, onSort, align,
}: {
  label: string
  sortKey: string
  current: string
  dir: 'asc' | 'desc'
  onSort: (key: string) => void
  align?: 'left' | 'right'
}) {
  const active = current === sortKey
  return (
    <th className={`px-3 py-2 text-${align ?? 'left'} text-[11px] font-semibold uppercase tracking-wider text-slate-700`}>
      <button onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 hover:text-slate-900">
        {label}
        {active && (dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    </th>
  )
}

function CarrierLink({
  carrierCode, trackingNumber, trackingUrl,
}: { carrierCode: string | null; trackingNumber: string | null; trackingUrl: string | null }) {
  if (!trackingNumber && !carrierCode) return <span className="text-slate-400 text-[11px]">—</span>
  if (!trackingNumber) {
    return <span className="text-[12px] text-slate-700 font-mono">{carrierCode}</span>
  }
  const fn = carrierCode ? CARRIER_TRACKING_URL[carrierCode.toUpperCase()] : null
  const url = fn ? fn(trackingNumber) : trackingUrl
  if (!url) {
    return (
      <span className="text-[12px]">
        <span className="text-slate-700 font-mono">{carrierCode ?? '—'}</span>
        <span className="text-slate-500 mx-1">·</span>
        <span className="text-slate-700 font-mono">{trackingNumber}</span>
      </span>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-[12px] hover:underline"
    >
      <span className="text-slate-700 font-mono">{carrierCode ?? '—'}</span>
      <span className="text-slate-500 mx-1">·</span>
      <span className="text-blue-700 font-mono">{trackingNumber}</span>
    </a>
  )
}

// ─────────────────────────────────────────────────────────────────────
// InboundDrawer — minor surface for new H.1/H.2 fields. Full rebuild
// (multi-section drawer with QC release + photo upload + discrepancy
// composer) lands in Commit 6 (web receive flow).
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// InboundDrawer — H.6 multi-section operations surface.
//
// Sections (top to bottom):
//   - Sticky header (type + status, close)
//   - Status timeline (horizontal step indicator)
//   - Carrier card (when any field set)
//   - Cost card (when any cost set)
//   - Items list — each item is a card with progress bar, receive
//     input, QC dropdown, photo paste, and an expand toggle for
//     receipt history + release-hold + discrepancy quick-add.
//   - Ship-level discrepancies section (list + composer)
//   - Attachments section (list + add-by-URL composer)
//   - Sticky action bar at bottom (Bulk fill, Submit receive,
//     status transitions, Cancel)
// ─────────────────────────────────────────────────────────────────────
const STATUS_STEPS: InboundStatus[] = [
  'DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED',
  'RECEIVING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILED', 'CLOSED',
]

const DISCREPANCY_REASONS: Array<{ value: string; label: string }> = [
  { value: 'SHORT_SHIP',    label: 'Short ship' },
  { value: 'OVER_SHIP',     label: 'Over ship' },
  { value: 'WRONG_ITEM',    label: 'Wrong item' },
  { value: 'DAMAGED',       label: 'Damaged' },
  { value: 'QUALITY_ISSUE', label: 'Quality issue' },
  { value: 'LATE_ARRIVAL',  label: 'Late arrival' },
  { value: 'COST_VARIANCE', label: 'Cost variance' },
  { value: 'OTHER',         label: 'Other' },
]

const ATTACHMENT_KINDS = ['INVOICE', 'PACKING', 'CUSTOMS', 'ASN', 'PHOTO', 'OTHER']

function InboundDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [shipment, setShipment] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [receiveBuf, setReceiveBuf] = useState<Record<string, { qty: string; qc: string; photoUrl: string }>>({})
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [composerOpen, setComposerOpen] = useState<null | { kind: 'discrepancy' } | { kind: 'discrepancyForItem'; itemId: string } | { kind: 'attachment' }>(null)
  const [busy, setBusy] = useState(false)

  const fetchOne = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}`, { cache: 'no-store' })
      setShipment(await r.json())
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { fetchOne() }, [fetchOne])

  const submitReceive = async () => {
    const updates = Object.entries(receiveBuf)
      .map(([itemId, v]) => {
        const qty = Number(v.qty)
        if (!Number.isFinite(qty) || qty < 0) return null
        const photoUrls = v.photoUrl?.trim() ? [v.photoUrl.trim()] : undefined
        // Skip rows with neither a non-zero qty target nor a QC update nor a photo.
        const item = shipment?.items?.find((it: any) => it.id === itemId)
        const cumulativeChanges = qty !== (item?.quantityReceived ?? 0)
        const qcChanges = v.qc !== (item?.qcStatus ?? '')
        if (!cumulativeChanges && !qcChanges && !photoUrls) return null
        return {
          itemId,
          quantityReceived: cumulativeChanges ? qty : (item?.quantityReceived ?? 0),
          qcStatus: v.qc || undefined,
          photoUrls,
        }
      })
      .filter(Boolean)
    if (updates.length === 0) { alert('Enter received quantities, change QC, or paste a photo URL'); return }
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: updates }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Receive failed')
      }
      setReceiveBuf({})
      setShipment(await res.json())
      // Re-fetch full bundle (receive returns shipment but not includes)
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const fillExpected = () => {
    const next: typeof receiveBuf = {}
    for (const it of shipment?.items ?? []) {
      const remaining = Math.max(0, it.quantityExpected - it.quantityReceived)
      if (remaining > 0) {
        next[it.id] = {
          qty: String(it.quantityReceived + remaining),
          qc: receiveBuf[it.id]?.qc ?? 'PASS',
          photoUrl: receiveBuf[it.id]?.photoUrl ?? '',
        }
      }
    }
    setReceiveBuf(next)
  }

  const transition = async (status: string) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Transition failed')
      }
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const releaseHold = async (itemId: string) => {
    if (!confirm('Release the held units to stock?')) return
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/items/${itemId}/release-hold`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Release failed')
      }
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const submitDiscrepancy = async (payload: any) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/discrepancies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Discrepancy create failed')
      }
      setComposerOpen(null)
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const submitAttachment = async (payload: any) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Attachment add failed')
      }
      setComposerOpen(null)
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const updateDiscrepancyStatus = async (did: string, status: string) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/discrepancies/${did}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Update failed')
      }
      fetchOne()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const toggleExpand = (itemId: string) => {
    setExpandedItems((s) => {
      const next = new Set(s)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-3xl bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Sticky header */}
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <PackageCheck size={14} /> Inbound shipment
            {loading && <RefreshCw size={11} className="animate-spin text-slate-400" />}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchOne} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100" title="Refresh">
              <RefreshCw size={13} />
            </button>
            <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="p-5 space-y-4 flex-1">
          {loading || !shipment ? <div className="text-[12px] text-slate-500">Loading…</div> : (
            <>
              {/* Top — type + status + reference */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${TYPE_TONE[shipment.type as InboundType]}`}>{shipment.type}</span>
                <Badge variant={STATUS_VARIANT[shipment.status as InboundStatus] ?? 'default'} size="sm">{shipment.status.replace(/_/g, ' ')}</Badge>
                {shipment.reference && <span className="text-[12px] text-slate-500 font-mono">{shipment.reference}</span>}
                {shipment.purchaseOrder?.poNumber && (
                  <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                    <Link2 size={10} /> PO {shipment.purchaseOrder.poNumber}
                  </span>
                )}
                {shipment.fbaShipmentId && (
                  <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                    FBA · {shipment.fbaShipmentId}
                  </span>
                )}
              </div>

              {/* Status timeline */}
              <StatusTimeline current={shipment.status as InboundStatus} cancelled={shipment.status === 'CANCELLED'} />

              {/* Carrier */}
              {(shipment.carrierCode || shipment.trackingNumber || shipment.expectedAt) && (
                <DrawerSection title="Carrier" icon={Truck}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CarrierLink carrierCode={shipment.carrierCode} trackingNumber={shipment.trackingNumber} trackingUrl={shipment.trackingUrl} />
                    {shipment.expectedAt && (() => {
                      const eta = new Date(shipment.expectedAt)
                      const isLate = eta.getTime() < Date.now() && !['RECEIVED', 'RECONCILED', 'CLOSED'].includes(shipment.status)
                      const daysLate = isLate ? Math.floor((Date.now() - eta.getTime()) / 86400_000) : 0
                      return (
                        <span className={`text-[11px] inline-flex items-center gap-1 ${isLate ? 'text-rose-700 font-semibold' : 'text-slate-500'}`}>
                          <CalendarClock size={11} />
                          ETA {eta.toLocaleDateString('en-GB')}
                          {isLate && <span className="text-[10px] bg-rose-100 px-1.5 py-0.5 rounded ml-1">{daysLate}d late</span>}
                        </span>
                      )
                    })()}
                  </div>
                </DrawerSection>
              )}

              {/* Costs */}
              {(shipment.shippingCostCents || shipment.customsCostCents || shipment.dutiesCostCents || shipment.insuranceCostCents) && (
                <DrawerSection title={`Landed cost (${shipment.currencyCode})`} icon={Boxes}>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    {shipment.shippingCostCents != null && <CostRow label="Shipping" cents={shipment.shippingCostCents} />}
                    {shipment.customsCostCents != null && <CostRow label="Customs" cents={shipment.customsCostCents} />}
                    {shipment.dutiesCostCents != null && <CostRow label="Duties" cents={shipment.dutiesCostCents} />}
                    {shipment.insuranceCostCents != null && <CostRow label="Insurance" cents={shipment.insuranceCostCents} />}
                  </div>
                </DrawerSection>
              )}

              {/* Items */}
              <DrawerSection
                title={`Items (${shipment.items.length})`}
                icon={PackageCheck}
                right={
                  <div className="inline-flex items-center gap-3">
                    <Link
                      href={`/fulfillment/inbound/${id}/receive`}
                      className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-1"
                      title="Open mobile receive flow (touch-friendly, camera scan + photo)"
                    >
                      <Smartphone size={10} /> Mobile receive
                    </Link>
                    <button onClick={fillExpected} className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-1">
                      <Check size={10} /> Fill all expected
                    </button>
                  </div>
                }
              >
                <div className="space-y-2">
                  {shipment.items.map((it: any) => (
                    <ItemRow
                      key={it.id}
                      item={it}
                      buf={receiveBuf[it.id]}
                      expanded={expandedItems.has(it.id)}
                      onBufChange={(v) => setReceiveBuf({ ...receiveBuf, [it.id]: v })}
                      onToggleExpand={() => toggleExpand(it.id)}
                      onReleaseHold={() => releaseHold(it.id)}
                      onAddDiscrepancy={() => setComposerOpen({ kind: 'discrepancyForItem', itemId: it.id })}
                    />
                  ))}
                </div>
              </DrawerSection>

              {/* Ship-level discrepancies */}
              <DrawerSection
                title={`Discrepancies (${shipment.discrepancies?.length ?? 0})`}
                icon={AlertTriangle}
                right={
                  <button
                    onClick={() => setComposerOpen({ kind: 'discrepancy' })}
                    className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-1"
                  >
                    <Plus size={10} /> Add discrepancy
                  </button>
                }
              >
                {shipment.discrepancies?.length === 0 ? (
                  <div className="text-[11px] text-slate-400 py-2">No ship-level discrepancies.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {shipment.discrepancies.map((d: any) => (
                      <DiscrepancyRow key={d.id} d={d} onUpdateStatus={(s) => updateDiscrepancyStatus(d.id, s)} />
                    ))}
                  </ul>
                )}
                {composerOpen?.kind === 'discrepancy' && (
                  <DiscrepancyComposer
                    onCancel={() => setComposerOpen(null)}
                    onSubmit={submitDiscrepancy}
                    busy={busy}
                  />
                )}
                {composerOpen?.kind === 'discrepancyForItem' && (
                  <DiscrepancyComposer
                    itemId={composerOpen.itemId}
                    itemSku={shipment.items.find((it: any) => it.id === composerOpen.itemId)?.sku}
                    onCancel={() => setComposerOpen(null)}
                    onSubmit={submitDiscrepancy}
                    busy={busy}
                  />
                )}
              </DrawerSection>

              {/* Attachments */}
              <DrawerSection
                title={`Attachments (${shipment.attachments?.length ?? 0})`}
                icon={FileText}
                right={
                  <button
                    onClick={() => setComposerOpen({ kind: 'attachment' })}
                    className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-1"
                  >
                    <Plus size={10} /> Add attachment
                  </button>
                }
              >
                {shipment.attachments?.length === 0 ? (
                  <div className="text-[11px] text-slate-400 py-2">No attachments.</div>
                ) : (
                  <ul className="space-y-1">
                    {shipment.attachments.map((a: any) => (
                      <li key={a.id} className="flex items-center justify-between text-[11px] py-1">
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <span className="text-[9px] uppercase font-semibold text-slate-500 bg-slate-100 px-1 py-0.5 rounded">{a.kind}</span>
                          <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline truncate">
                            {a.filename ?? a.url}
                          </a>
                        </span>
                        <span className="text-[10px] text-slate-400 flex-shrink-0">{new Date(a.uploadedAt).toLocaleDateString('en-GB')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {composerOpen?.kind === 'attachment' && (
                  <AttachmentComposer
                    onCancel={() => setComposerOpen(null)}
                    onSubmit={submitAttachment}
                    busy={busy}
                  />
                )}
              </DrawerSection>
            </>
          )}
        </div>

        {/* Sticky action bar */}
        {shipment && !loading && (
          <footer className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 flex-wrap sticky bottom-0 bg-white">
            <button
              onClick={submitReceive}
              disabled={busy || Object.keys(receiveBuf).length === 0}
              className="h-8 px-3 text-[12px] bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <ArrowDownToLine size={12} /> {busy ? 'Submitting…' : 'Submit receive'}
            </button>
            {shipment.status === 'DRAFT' && (
              <button onClick={() => transition('SUBMITTED')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Mark submitted</button>
            )}
            {shipment.status === 'SUBMITTED' && (
              <button onClick={() => transition('IN_TRANSIT')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Mark in transit</button>
            )}
            {shipment.status === 'IN_TRANSIT' && (
              <button onClick={() => transition('ARRIVED')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Mark arrived</button>
            )}
            {shipment.status === 'ARRIVED' && (
              <button onClick={() => transition('RECEIVING')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Start receiving</button>
            )}
            {(shipment.status === 'RECEIVED' || shipment.status === 'RECONCILED') && (
              <button onClick={() => transition('CLOSED')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Close</button>
            )}
            {shipment.status !== 'CLOSED' && shipment.status !== 'CANCELLED' && (
              <button
                onClick={() => { if (confirm('Cancel shipment? This is terminal.')) transition('CANCELLED') }}
                className="ml-auto h-8 px-3 text-[12px] text-rose-700 hover:bg-rose-50 rounded"
              >Cancel</button>
            )}
          </footer>
        )}
      </aside>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Drawer sub-components
// ─────────────────────────────────────────────────────────────────────
function DrawerSection({
  title, icon: Icon, right, children,
}: { title: string; icon: any; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 rounded-md p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
          <Icon size={11} className="text-slate-400" />
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function StatusTimeline({ current, cancelled }: { current: InboundStatus; cancelled: boolean }) {
  if (cancelled) {
    return (
      <div className="text-[11px] inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-700 rounded">
        <X size={12} className="text-rose-500" />
        Shipment cancelled
      </div>
    )
  }
  const idx = STATUS_STEPS.indexOf(current)
  const visibleSteps = idx === -1 ? STATUS_STEPS : STATUS_STEPS
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {visibleSteps.map((s, i) => {
        const isCurrent = s === current
        const isPast = i < idx && idx !== -1
        const dotCls = isCurrent ? 'bg-blue-600 ring-4 ring-blue-100'
                        : isPast  ? 'bg-emerald-500'
                        : 'bg-slate-300'
        const labelCls = isCurrent ? 'text-blue-700 font-semibold'
                          : isPast  ? 'text-emerald-700'
                          : 'text-slate-400'
        return (
          <div key={s} className="flex items-center gap-1 flex-shrink-0">
            <span className={`w-2 h-2 rounded-full ${dotCls}`} />
            <span className={`text-[10px] uppercase tracking-wider ${labelCls}`}>
              {s.replace(/_/g, ' ')}
            </span>
            {i < visibleSteps.length - 1 && <span className="w-3 h-px bg-slate-200" />}
          </div>
        )
      })}
    </div>
  )
}

function CostRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums float-right">{(cents / 100).toFixed(2)}</span>
    </div>
  )
}

function ItemRow({
  item, buf, expanded, onBufChange, onToggleExpand, onReleaseHold, onAddDiscrepancy,
}: {
  item: any
  buf: { qty: string; qc: string; photoUrl: string } | undefined
  expanded: boolean
  onBufChange: (v: { qty: string; qc: string; photoUrl: string }) => void
  onToggleExpand: () => void
  onReleaseHold: () => void
  onAddDiscrepancy: () => void
}) {
  const target = buf?.qty ?? ''
  const qc = buf?.qc ?? ''
  const photoUrl = buf?.photoUrl ?? ''
  const remaining = Math.max(0, item.quantityExpected - item.quantityReceived)
  const pct = item.quantityExpected > 0 ? Math.round((item.quantityReceived / item.quantityExpected) * 100) : 0
  const onHold = item.qcStatus === 'HOLD' || item.qcStatus === 'FAIL'

  return (
    <div className="border border-slate-200 rounded">
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap">
        <button onClick={onToggleExpand} className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 flex-shrink-0">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-mono font-semibold text-slate-900 truncate">{item.sku}</div>
          <div className="text-[10px] text-slate-500 mt-0.5 inline-flex items-center gap-2">
            <span className="tabular-nums">{item.quantityReceived}/{item.quantityExpected} received</span>
            {remaining > 0 && <span className="text-amber-700">{remaining} remaining</span>}
            {item.qcStatus && (
              <span className={`uppercase font-semibold tracking-wider px-1 rounded ${
                item.qcStatus === 'PASS' ? 'bg-emerald-100 text-emerald-700' :
                item.qcStatus === 'HOLD' ? 'bg-amber-100 text-amber-700' :
                item.qcStatus === 'FAIL' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'
              }`}>{item.qcStatus}</span>
            )}
            {(item.photoUrls?.length ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 text-slate-500"><Camera size={9} /> {item.photoUrls.length}</span>
            )}
            {(item.discrepancies?.length ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 text-rose-700"><AlertTriangle size={9} /> {item.discrepancies.length}</span>
            )}
          </div>
          <div className="mt-1 h-1 bg-slate-100 rounded overflow-hidden">
            <div className={`h-full ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <input
          type="number"
          min="0"
          value={target}
          onChange={(e) => onBufChange({ qty: e.target.value, qc, photoUrl })}
          placeholder={String(item.quantityReceived)}
          className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded text-[12px]"
          title="Cumulative target. Server computes delta."
        />
        <select
          value={qc}
          onChange={(e) => onBufChange({ qty: target, qc: e.target.value, photoUrl })}
          className="h-7 px-1.5 text-[11px] border border-slate-200 rounded"
        >
          <option value="">QC —</option>
          <option value="PASS">PASS</option>
          <option value="HOLD">HOLD</option>
          <option value="FAIL">FAIL</option>
        </select>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-100 space-y-2">
          {/* Photo URL paste */}
          <div className="pt-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 inline-flex items-center gap-1">
              <Camera size={10} /> Add photo URL (Cloudinary or any image)
            </div>
            <input
              type="url"
              value={photoUrl}
              onChange={(e) => onBufChange({ qty: target, qc, photoUrl: e.target.value })}
              placeholder="https://res.cloudinary.com/…"
              className="w-full h-7 px-2 text-[11px] border border-slate-200 rounded"
            />
            <div className="text-[10px] text-slate-500 mt-1">Submitted with the next receive call. Camera + direct upload land in Commit 7.</div>
          </div>

          {/* Existing photos */}
          {(item.photoUrls?.length ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {item.photoUrls.map((u: string, i: number) => (
                <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={u} alt="" className="w-12 h-12 rounded object-cover border border-slate-200 bg-slate-100" />
                </a>
              ))}
            </div>
          )}

          {/* Receipt history */}
          {(item.receipts?.length ?? 0) > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 inline-flex items-center gap-1">
                <History size={10} /> Receipt history ({item.receipts.length})
              </div>
              <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                {item.receipts.slice(0, 10).map((r: any) => (
                  <li key={r.id} className="text-[10px] flex items-center justify-between text-slate-600">
                    <span>
                      <span className={`font-semibold tabular-nums ${r.quantity > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {r.quantity > 0 ? '+' : ''}{r.quantity}
                      </span>
                      {r.qcStatus && <span className="ml-2 uppercase">{r.qcStatus}</span>}
                      {r.notes && <span className="ml-2 italic text-slate-500 truncate">— {r.notes}</span>}
                    </span>
                    <span className="text-slate-400 tabular-nums">{new Date(r.receivedAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Item-level discrepancies */}
          {(item.discrepancies?.length ?? 0) > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Discrepancies</div>
              <ul className="space-y-0.5">
                {item.discrepancies.map((d: any) => (
                  <li key={d.id} className="text-[11px] inline-flex items-center gap-2">
                    <span className="text-[9px] uppercase font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-1 py-0.5 rounded">{d.reasonCode}</span>
                    <span className="text-slate-600">{d.status}</span>
                    {d.description && <span className="text-slate-500 truncate">— {d.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Item-level actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onAddDiscrepancy}
              className="h-7 px-2 text-[10px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
            >
              <Plus size={10} /> Add discrepancy
            </button>
            {onHold && (
              <button
                onClick={onReleaseHold}
                className="h-7 px-2 text-[10px] bg-amber-50 text-amber-800 border border-amber-200 rounded hover:bg-amber-100 inline-flex items-center gap-1"
              >
                <Unlock size={10} /> Release {item.qcStatus} hold ({item.quantityReceived})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DiscrepancyRow({ d, onUpdateStatus }: { d: any; onUpdateStatus: (s: string) => void }) {
  const statusTone =
    d.status === 'RESOLVED' ? 'bg-emerald-100 text-emerald-700' :
    d.status === 'WAIVED'   ? 'bg-slate-100 text-slate-700' :
    d.status === 'DISPUTED' ? 'bg-amber-100 text-amber-700' :
    'bg-rose-100 text-rose-700'
  const isOpen = d.status === 'REPORTED' || d.status === 'ACKNOWLEDGED'
  return (
    <li className="flex items-start justify-between gap-2 py-1 border-b border-slate-100 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="inline-flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
            {d.reasonCode}
          </span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${statusTone}`}>
            {d.status}
          </span>
        </div>
        {d.description && <div className="text-[11px] text-slate-600 mt-0.5">{d.description}</div>}
        <div className="text-[10px] text-slate-400 mt-0.5">{new Date(d.reportedAt).toLocaleDateString('en-GB')}{d.reportedBy ? ` · ${d.reportedBy}` : ''}</div>
      </div>
      {isOpen && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {d.status === 'REPORTED' && (
            <button onClick={() => onUpdateStatus('ACKNOWLEDGED')} className="h-6 px-1.5 text-[10px] text-amber-700 hover:bg-amber-50 rounded">Ack</button>
          )}
          <button onClick={() => onUpdateStatus('RESOLVED')} className="h-6 px-1.5 text-[10px] text-emerald-700 hover:bg-emerald-50 rounded">Resolve</button>
          <button onClick={() => onUpdateStatus('WAIVED')} className="h-6 px-1.5 text-[10px] text-slate-500 hover:bg-slate-50 rounded">Waive</button>
        </div>
      )}
    </li>
  )
}

function DiscrepancyComposer({
  itemId, itemSku, onCancel, onSubmit, busy,
}: {
  itemId?: string
  itemSku?: string
  onCancel: () => void
  onSubmit: (payload: any) => void
  busy: boolean
}) {
  const [reasonCode, setReasonCode] = useState('SHORT_SHIP')
  const [description, setDescription] = useState('')
  const [qtyImpact, setQtyImpact] = useState('')

  const submit = () => {
    onSubmit({
      itemId,
      reasonCode,
      description: description || undefined,
      quantityImpact: qtyImpact ? Number(qtyImpact) : undefined,
    })
  }

  return (
    <div className="border border-rose-200 bg-rose-50/30 rounded-md p-3 mt-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-rose-700 font-semibold">
        New discrepancy {itemSku && <span className="text-rose-600">— {itemSku}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] text-slate-500 mb-1">Reason</div>
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="h-7 w-full px-1.5 text-[11px] border border-slate-200 rounded">
            {DISCREPANCY_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[10px] text-slate-500 mb-1">Quantity impact (signed)</div>
          <input
            type="number"
            value={qtyImpact}
            onChange={(e) => setQtyImpact(e.target.value)}
            placeholder="+5 = over, -5 = short"
            className="h-7 w-full px-2 text-[11px] tabular-nums border border-slate-200 rounded"
          />
        </div>
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (visible to supplier on resolution PDF — Commit 17)"
        rows={2}
        className="w-full px-2 py-1 text-[11px] border border-slate-200 rounded"
      />
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-7 px-2 text-[11px] text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={busy} className="h-7 px-3 text-[11px] bg-rose-600 text-white rounded hover:bg-rose-700 disabled:opacity-50">
          {busy ? 'Saving…' : 'Create'}
        </button>
      </div>
    </div>
  )
}

function AttachmentComposer({
  onCancel, onSubmit, busy,
}: { onCancel: () => void; onSubmit: (p: any) => void; busy: boolean }) {
  const [kind, setKind] = useState('INVOICE')
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')

  const submit = () => {
    if (!url) { alert('URL required'); return }
    onSubmit({ kind, url, filename: filename || undefined })
  }

  return (
    <div className="border border-slate-300 bg-slate-50/50 rounded-md p-3 mt-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-700 font-semibold">New attachment</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] text-slate-500 mb-1">Kind</div>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-7 w-full px-1.5 text-[11px] border border-slate-200 rounded">
            {ATTACHMENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[10px] text-slate-500 mb-1">Filename (optional)</div>
          <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="invoice.pdf" className="h-7 w-full px-2 text-[11px] border border-slate-200 rounded" />
        </div>
      </div>
      <div>
        <div className="text-[10px] text-slate-500 mb-1">URL</div>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://res.cloudinary.com/.../inbound/.../file.pdf"
          className="w-full h-7 px-2 text-[11px] border border-slate-200 rounded"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-7 px-2 text-[11px] text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={busy} className="h-7 px-3 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">
          {busy ? 'Saving…' : 'Add'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// CreateInboundModal — H.4 rebuild.
// Three sources: Manual entry · Link to PO · CSV import. Carrier +
// tracking + ASN + multi-currency cost capture in collapsible
// sections so simple flows stay simple. All H.1 fields surface here;
// every section is optional except items.
// ─────────────────────────────────────────────────────────────────────
type ItemRow = {
  sku: string
  quantityExpected: number
  unitCostCents?: number | null
  productId?: string | null
  purchaseOrderItemId?: string | null
}

type PurchaseOrderLite = {
  id: string
  poNumber: string
  status: string
  currencyCode: string
  warehouseId: string | null
  supplier: { id: string; name: string } | null
  warehouse: { code: string } | null
  items: Array<{
    id: string
    sku: string
    productId: string | null
    quantityOrdered: number
    quantityReceived: number
    unitCostCents: number
  }>
}

const CARRIER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',       label: '— None —' },
  { value: 'BRT',    label: 'BRT' },
  { value: 'POSTE',  label: 'Poste Italiane' },
  { value: 'GLS',    label: 'GLS' },
  { value: 'SDA',    label: 'SDA' },
  { value: 'TNT',    label: 'TNT' },
  { value: 'DHL',    label: 'DHL' },
  { value: 'UPS',    label: 'UPS' },
  { value: 'FEDEX',  label: 'FedEx' },
  { value: 'DSV',    label: 'DSV' },
  { value: 'OTHER',  label: 'Other' },
]

const CURRENCY_OPTIONS = ['EUR', 'USD', 'GBP', 'CNY', 'CHF', 'JPY']

// Tiny client-side CSV parser. Accepts:
//   sku,quantityExpected,unitCostCents
//   SKU-001,10,1200
// Header row optional. Whitespace tolerant. Strips quoted strings.
function parseItemsCsv(text: string): ItemRow[] {
  const rows: ItemRow[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return rows
  // Skip header if first row looks non-numeric on the qty column.
  let start = 0
  const firstCells = lines[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
  if (firstCells.length >= 2 && !Number.isFinite(Number(firstCells[1]))) start = 1
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    if (cells.length < 2) continue
    const sku = cells[0]
    const qty = Number(cells[1])
    if (!sku || !Number.isFinite(qty) || qty <= 0) continue
    const cost = cells[2] && cells[2] !== '' ? Number(cells[2]) : null
    rows.push({
      sku,
      quantityExpected: Math.floor(qty),
      unitCostCents: cost != null && Number.isFinite(cost) ? Math.floor(cost) : null,
    })
  }
  return rows
}

function CreateInboundModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [source, setSource] = useState<'MANUAL' | 'PO' | 'CSV'>('MANUAL')
  const [type, setType] = useState<'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'>('SUPPLIER')
  const [reference, setReference] = useState('')
  const [asnNumber, setAsnNumber] = useState('')
  // ASN file upload UI lands when Cloudinary direct-upload is wired
  // for inbound (Commit 7). The field is in the H.1 body schema; the
  // form just doesn't expose it yet.
  const asnFileUrl = ''
  const [expectedAt, setExpectedAt] = useState('')
  const [notes, setNotes] = useState('')

  // Carrier section
  const [carrierOpen, setCarrierOpen] = useState(false)
  const [carrierCode, setCarrierCode] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [trackingUrl, setTrackingUrl] = useState('')

  // Cost section
  const [costOpen, setCostOpen] = useState(false)
  const [currencyCode, setCurrencyCode] = useState('EUR')
  const [exchangeRate, setExchangeRate] = useState('')
  const [shippingCost, setShippingCost] = useState('')
  const [customsCost, setCustomsCost] = useState('')
  const [dutiesCost, setDutiesCost] = useState('')
  const [insuranceCost, setInsuranceCost] = useState('')

  // Items
  const [items, setItems] = useState<ItemRow[]>([{ sku: '', quantityExpected: 1 }])
  const [linkedPoId, setLinkedPoId] = useState<string | null>(null)

  // PO picker state
  const [poList, setPoList] = useState<PurchaseOrderLite[] | null>(null)
  const [poLoading, setPoLoading] = useState(false)

  // CSV paste state
  const [csvText, setCsvText] = useState('')

  const [busy, setBusy] = useState(false)

  const loadOpenPos = useCallback(async () => {
    setPoLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders?status=SUBMITTED,CONFIRMED,PARTIAL,DRAFT`,
        { cache: 'no-store' },
      )
      if (res.ok) {
        const data = await res.json()
        setPoList(data.items ?? [])
      }
    } finally { setPoLoading(false) }
  }, [])

  useEffect(() => { if (source === 'PO' && poList === null) loadOpenPos() }, [source, poList, loadOpenPos])

  const pickPo = (po: PurchaseOrderLite) => {
    setLinkedPoId(po.id)
    setReference(`Receipt for ${po.poNumber}`)
    setCurrencyCode(po.currencyCode || 'EUR')
    const remaining = po.items.map<ItemRow>((it) => ({
      sku: it.sku,
      quantityExpected: Math.max(0, it.quantityOrdered - (it.quantityReceived ?? 0)),
      unitCostCents: it.unitCostCents,
      productId: it.productId,
      purchaseOrderItemId: it.id,
    })).filter((r) => r.quantityExpected > 0)
    setItems(remaining.length > 0 ? remaining : [{ sku: '', quantityExpected: 1 }])
  }

  const applyCsv = () => {
    const parsed = parseItemsCsv(csvText)
    if (parsed.length === 0) {
      alert('No valid rows parsed. Format: sku,quantityExpected[,unitCostCents]')
      return
    }
    setItems(parsed)
    setCsvText('')
  }

  const submit = async () => {
    const filtered = items.filter((it) => it.sku.trim() && it.quantityExpected > 0)
    if (filtered.length === 0) {
      alert('Add at least one item with SKU + quantity > 0')
      return
    }
    setBusy(true)
    try {
      const body: any = {
        type,
        reference: reference || undefined,
        notes: notes || undefined,
        asnNumber: asnNumber || undefined,
        asnFileUrl: asnFileUrl || undefined,
        expectedAt: expectedAt ? new Date(expectedAt).toISOString() : undefined,
        purchaseOrderId: linkedPoId || undefined,
        carrierCode: carrierCode || undefined,
        trackingNumber: trackingNumber || undefined,
        trackingUrl: trackingUrl || undefined,
        currencyCode: currencyCode || undefined,
        exchangeRate: exchangeRate ? Number(exchangeRate) : undefined,
        shippingCostCents: shippingCost ? Math.round(Number(shippingCost) * 100) : undefined,
        customsCostCents: customsCost ? Math.round(Number(customsCost) * 100) : undefined,
        dutiesCostCents: dutiesCost ? Math.round(Number(dutiesCost) * 100) : undefined,
        insuranceCostCents: insuranceCost ? Math.round(Number(insuranceCost) * 100) : undefined,
        items: filtered.map((it) => ({
          sku: it.sku.trim(),
          quantityExpected: it.quantityExpected,
          productId: it.productId ?? undefined,
          purchaseOrderItemId: it.purchaseOrderItemId ?? undefined,
          unitCostCents: it.unitCostCents ?? undefined,
        })),
      }
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Create failed')
      }
      onCreated()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[88vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[14px] font-semibold text-slate-900">New inbound shipment</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4">
          {/* Source picker */}
          <div className="grid grid-cols-3 gap-2">
            <SourceCard
              icon={Plus}
              label="Manual entry"
              hint="Type SKUs + qty by hand"
              active={source === 'MANUAL'}
              onClick={() => { setSource('MANUAL'); setLinkedPoId(null) }}
            />
            <SourceCard
              icon={Link2}
              label="Link to PO"
              hint="Pull items from an existing PO"
              active={source === 'PO'}
              onClick={() => setSource('PO')}
            />
            <SourceCard
              icon={Upload}
              label="CSV import"
              hint="Paste from supplier ASN or CSV"
              active={source === 'CSV'}
              onClick={() => { setSource('CSV'); setLinkedPoId(null) }}
            />
          </div>

          {/* Type + reference */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Type</div>
              <div className="flex items-center gap-2">
                {(['SUPPLIER', 'MANUFACTURING', 'TRANSFER'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`h-7 px-3 text-[11px] border rounded ${type === t ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200'}`}
                  >{t}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Expected arrival</div>
              <input
                type="date"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className="h-8 w-full px-2 text-[12px] border border-slate-200 rounded"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Reference</div>
              <input
                type="text" value={reference} onChange={(e) => setReference(e.target.value)}
                placeholder="Invoice #, transport doc…"
                className="h-8 w-full px-2 text-[12px] border border-slate-200 rounded"
              />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">ASN number</div>
              <input
                type="text" value={asnNumber} onChange={(e) => setAsnNumber(e.target.value)}
                placeholder="Supplier-provided ASN ref"
                className="h-8 w-full px-2 text-[12px] border border-slate-200 rounded"
              />
            </div>
          </div>

          {/* Source-specific section */}
          {source === 'PO' && (
            <PoPicker
              poList={poList}
              loading={poLoading}
              linkedPoId={linkedPoId}
              onPick={pickPo}
              onRefresh={loadOpenPos}
            />
          )}
          {source === 'CSV' && (
            <div className="border border-slate-200 rounded p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">CSV import</div>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={`sku,quantityExpected,unitCostCents\nSKU-001,10,1200\nSKU-002,5,800`}
                rows={5}
                className="w-full font-mono text-[11px] border border-slate-200 rounded p-2"
              />
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-slate-500">Header optional. unitCostCents optional.</div>
                <button
                  onClick={applyCsv}
                  className="h-7 px-3 text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100"
                >Parse {csvText.split(/\r?\n/).filter(Boolean).length} lines →</button>
              </div>
            </div>
          )}

          {/* Carrier (collapsible) */}
          <CollapseSection
            label="Carrier + tracking"
            open={carrierOpen}
            onToggle={() => setCarrierOpen(!carrierOpen)}
            count={[carrierCode, trackingNumber].filter(Boolean).length}
          >
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-[10px] text-slate-500 mb-1">Carrier</div>
                <select value={carrierCode} onChange={(e) => setCarrierCode(e.target.value)} className="h-7 w-full px-1.5 text-[12px] border border-slate-200 rounded">
                  {CARRIER_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <div className="text-[10px] text-slate-500 mb-1">Tracking number</div>
                <input type="text" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Carrier tracking #" className="h-7 w-full px-2 text-[12px] font-mono border border-slate-200 rounded" />
              </div>
            </div>
            <div className="mt-2">
              <div className="text-[10px] text-slate-500 mb-1">Override tracking URL (optional — frontend computes from carrier + number when blank)</div>
              <input type="url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} placeholder="https://…" className="h-7 w-full px-2 text-[11px] border border-slate-200 rounded" />
            </div>
          </CollapseSection>

          {/* Costs (collapsible) */}
          <CollapseSection
            label="Costs"
            open={costOpen}
            onToggle={() => setCostOpen(!costOpen)}
            count={[shippingCost, customsCost, dutiesCost, insuranceCost].filter(Boolean).length}
          >
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-slate-500 mb-1">Currency</div>
                <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="h-7 w-full px-1.5 text-[12px] border border-slate-200 rounded">
                  {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 mb-1">FX rate to EUR (optional)</div>
                <input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="e.g. 0.92" className="h-7 w-full px-2 text-[12px] tabular-nums border border-slate-200 rounded" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <CostInput label="Shipping" value={shippingCost} onChange={setShippingCost} currency={currencyCode} />
              <CostInput label="Customs" value={customsCost} onChange={setCustomsCost} currency={currencyCode} />
              <CostInput label="Duties" value={dutiesCost} onChange={setDutiesCost} currency={currencyCode} />
              <CostInput label="Insurance" value={insuranceCost} onChange={setInsuranceCost} currency={currencyCode} />
            </div>
          </CollapseSection>

          {/* Items table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                Items ({items.filter((i) => i.sku.trim()).length})
              </div>
              {linkedPoId && (
                <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                  Linked to PO — items locked to remaining qty
                </span>
              )}
            </div>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-1.5 py-1 text-left text-[10px] uppercase text-slate-500">SKU</th>
                  <th className="px-1.5 py-1 text-right text-[10px] uppercase text-slate-500 w-20">Qty</th>
                  <th className="px-1.5 py-1 text-right text-[10px] uppercase text-slate-500 w-24">Unit cost ({currencyCode})</th>
                  <th className="w-7"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-1.5 py-1">
                      <input
                        type="text" value={row.sku}
                        onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))}
                        placeholder="SKU"
                        className="w-full h-7 px-1.5 text-[12px] font-mono border border-slate-200 rounded"
                      />
                    </td>
                    <td className="px-1.5 py-1 text-right">
                      <input
                        type="number" min="1" value={row.quantityExpected}
                        onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, quantityExpected: Number(e.target.value) || 1 } : s))}
                        className="w-full h-7 px-1.5 text-right tabular-nums border border-slate-200 rounded"
                      />
                    </td>
                    <td className="px-1.5 py-1 text-right">
                      <input
                        type="number" step="0.01"
                        value={row.unitCostCents != null ? (row.unitCostCents / 100).toFixed(2) : ''}
                        onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, unitCostCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null } : s))}
                        placeholder="—"
                        className="w-full h-7 px-1.5 text-right tabular-nums border border-slate-200 rounded"
                      />
                    </td>
                    <td className="text-center">
                      <button
                        onClick={() => setItems(items.filter((_, j) => j !== i))}
                        className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"
                      ><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={() => setItems([...items, { sku: '', quantityExpected: 1 }])}
              className="mt-2 text-[11px] text-blue-600 hover:underline"
            >+ Add item</button>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Notes</div>
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Internal notes (visible in drawer)"
              className="w-full px-2 py-1 text-[12px] border border-slate-200 rounded"
            />
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-slate-200 flex items-center justify-between sticky bottom-0 bg-white">
          <div className="text-[11px] text-slate-500">
            Saves as DRAFT. Transition to SUBMITTED from the drawer.
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
            <button onClick={submit} disabled={busy} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">
              {busy ? 'Creating…' : 'Create draft'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function SourceCard({
  icon: Icon, label, hint, active, onClick,
}: { icon: any; label: string; hint: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`p-3 rounded text-left transition-colors border ${
        active ? 'bg-slate-900 text-white border-slate-900'
               : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <Icon size={14} />
        <span className="text-[12px] font-semibold">{label}</span>
      </div>
      <div className={`text-[10px] leading-tight ${active ? 'text-slate-300' : 'text-slate-500'}`}>{hint}</div>
    </button>
  )
}

function CollapseSection({
  label, open, onToggle, count, children,
}: { label: string; open: boolean; onToggle: () => void; count: number; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 rounded">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-slate-50"
      >
        <span className="text-[11px] uppercase tracking-wider text-slate-700 font-semibold inline-flex items-center gap-2">
          {label}
          {count > 0 && <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-mono">{count}</span>}
        </span>
        {open ? <ChevronUp size={12} className="text-slate-400" /> : <ChevronDown size={12} className="text-slate-400" />}
      </button>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  )
}

function CostInput({
  label, value, onChange, currency,
}: { label: string; value: string; onChange: (v: string) => void; currency: string }) {
  return (
    <div>
      <div className="text-[10px] text-slate-500 mb-1">{label} ({currency})</div>
      <input
        type="number" step="0.01" value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className="h-7 w-full px-2 text-[12px] tabular-nums border border-slate-200 rounded"
      />
    </div>
  )
}

function PoPicker({
  poList, loading, linkedPoId, onPick, onRefresh,
}: {
  poList: PurchaseOrderLite[] | null
  loading: boolean
  linkedPoId: string | null
  onPick: (po: PurchaseOrderLite) => void
  onRefresh: () => void
}) {
  return (
    <div className="border border-slate-200 rounded p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Open POs</div>
        <button onClick={onRefresh} className="h-6 px-2 text-[10px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
          <RefreshCw size={10} /> Refresh
        </button>
      </div>
      {loading ? (
        <div className="text-[11px] text-slate-500 py-2">Loading POs…</div>
      ) : !poList || poList.length === 0 ? (
        <div className="text-[11px] text-slate-500 py-2">No open purchase orders. Create one in /fulfillment/purchase-orders first.</div>
      ) : (
        <ul className="max-h-48 overflow-y-auto space-y-1">
          {poList.map((po) => {
            const totalRemaining = po.items.reduce((a, it) => a + Math.max(0, it.quantityOrdered - (it.quantityReceived ?? 0)), 0)
            const selected = linkedPoId === po.id
            return (
              <li key={po.id}>
                <button
                  onClick={() => onPick(po)}
                  disabled={totalRemaining === 0}
                  className={`w-full text-left px-2 py-1.5 rounded border text-[12px] ${
                    selected ? 'bg-emerald-50 border-emerald-300 text-emerald-900' :
                    totalRemaining === 0 ? 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed' :
                    'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-mono font-semibold">{po.poNumber}</span>
                      <span className="text-[10px] text-slate-500 ml-2">{po.status}</span>
                    </div>
                    <span className="text-[11px] tabular-nums">
                      {totalRemaining > 0 ? <>{totalRemaining} units</> : <>fully received</>}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {po.supplier?.name ?? 'No supplier'} · {po.warehouse?.code ?? '—'} · {po.currencyCode}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// H.10b — SavedViewsBar. Persistable named filter snapshots scoped
// to surface=inbound. Reuses the existing /api/saved-views CRUD that
// the global products page already uses (the SavedView model has a
// `surface` discriminator, so two surfaces share the table without
// schema work). One default view per user per surface is enforced
// at the API layer.
// ─────────────────────────────────────────────────────────────────────

type InboundFilters = {
  type?: string
  status?: string
  delayed?: string
  search?: string
  sortBy?: string
  sortDir?: string
}

type SavedViewRow = {
  id: string
  name: string
  filters: InboundFilters
  isDefault: boolean
}

function SavedViewsBar({
  currentFilters,
  onApply,
}: {
  currentFilters: InboundFilters
  onApply: (filters: InboundFilters) => void
}) {
  const [views, setViews] = useState<SavedViewRow[]>([])
  const [savingOpen, setSavingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDefault, setNewDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [defaultApplied, setDefaultApplied] = useState(false)

  const fetchViews = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views?surface=inbound`)
      const data = await res.json().catch(() => ({}))
      if (Array.isArray(data?.items)) {
        setViews(data.items.map((v: any) => ({ id: v.id, name: v.name, filters: v.filters ?? {}, isDefault: !!v.isDefault })))
      }
    } catch {
      // Soft-fail: saved views are convenience, not critical path.
    }
  }, [])

  useEffect(() => { void fetchViews() }, [fetchViews])

  // Auto-apply the user's default view ONCE on first load — but only
  // if the URL is at "everything blank" so we don't override a user
  // who came in via a deep link.
  const isClean =
    !currentFilters.type && !currentFilters.status && !currentFilters.delayed &&
    !currentFilters.search && (!currentFilters.sortBy || currentFilters.sortBy === 'createdAt') &&
    (!currentFilters.sortDir || currentFilters.sortDir === 'desc')
  useEffect(() => {
    if (defaultApplied) return
    if (!isClean) { setDefaultApplied(true); return }
    const def = views.find((v) => v.isDefault)
    if (def) {
      onApply(def.filters)
      setDefaultApplied(true)
    } else if (views.length >= 0) {
      // Mark applied so we don't keep checking on every render once
      // the views list resolves to "no default".
      setDefaultApplied(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, defaultApplied, isClean])

  const saveCurrent = async () => {
    const name = newName.trim()
    if (!name) { setError('Name required'); return }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          surface: 'inbound',
          filters: currentFilters,
          isDefault: newDefault,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`)
      setNewName('')
      setNewDefault(false)
      setSavingOpen(false)
      await fetchViews()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const removeView = async (id: string) => {
    if (!confirm('Delete this saved view?')) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      await fetchViews()
    } catch (e: any) {
      alert(e.message)
    }
  }

  const setAsDefault = async (id: string) => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) throw new Error(`Update failed (${res.status})`)
      await fetchViews()
    } catch (e: any) {
      alert(e.message)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mt-1">Views</span>
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {views.length === 0 && !savingOpen && (
            <span className="text-[11px] text-slate-400 italic">No saved views yet — set up your filters and click "Save view" to capture them.</span>
          )}
          {views.map((v) => (
            <span
              key={v.id}
              className={`group inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full border text-[11px] ${
                v.isDefault
                  ? 'bg-blue-50 border-blue-200 text-blue-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <button
                onClick={() => onApply(v.filters)}
                className="inline-flex items-center gap-1"
                title={v.isDefault ? 'Default view — applied on load' : 'Apply this view'}
              >
                {v.isDefault && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />}
                {v.name}
              </button>
              {!v.isDefault && (
                <button
                  onClick={() => setAsDefault(v.id)}
                  className="opacity-0 group-hover:opacity-100 px-1 text-[9px] text-slate-500 hover:text-blue-600"
                  title="Set as default"
                >
                  ★
                </button>
              )}
              <button
                onClick={() => removeView(v.id)}
                className="h-5 w-5 inline-flex items-center justify-center rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                title="Delete view"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        {!savingOpen && (
          <button
            onClick={() => { setSavingOpen(true); setError(null) }}
            className="h-7 px-2.5 text-[11px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
          >
            <Plus size={11} /> Save view
          </button>
        )}
      </div>
      {savingOpen && (
        <div className="mt-2 pt-2 border-t border-slate-200 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="View name (e.g. Late from Vendor X)"
            className="h-7 px-2 text-[12px] border border-slate-200 rounded flex-1 min-w-[180px]"
            autoFocus
          />
          <label className="text-[11px] text-slate-600 inline-flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={newDefault}
              onChange={(e) => setNewDefault(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Set as default
          </label>
          <button
            onClick={saveCurrent}
            disabled={busy || !newName.trim()}
            className="h-7 px-2.5 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setSavingOpen(false); setNewName(''); setNewDefault(false); setError(null) }}
            className="h-7 px-2.5 text-[11px] border border-slate-200 rounded hover:bg-slate-50"
          >
            Cancel
          </button>
          {error && <span className="text-[11px] text-rose-700">{error}</span>}
        </div>
      )}
    </Card>
  )
}

// H.10a — BulkReceiveModal. Cross-shipment scan-receive. Operator
// scans/types a SKU; backend returns every open InboundShipmentItem
// for that SKU; if exactly one matches, auto-applies +1; if many,
// shows a picker. Last-N-receives log persists in modal state so
// the operator can watch their own throughput. Auto-refocuses the
// SKU input after each receive so a Bluetooth scanner can rip
// through cartons without the operator touching the page.
// ─────────────────────────────────────────────────────────────────────

type ReceiveCandidate = {
  itemId: string
  sku: string
  productName: string | null
  quantityExpected: number
  quantityReceived: number
  remaining: number
  shipment: {
    id: string
    reference: string | null
    type: string
    status: string
    expectedAt: string | null
  }
}

type ReceiveLogEntry = {
  ts: number
  sku: string
  shipmentRef: string | null
  applied: number
  ok: boolean
  message?: string
}

function BulkReceiveModal({ onClose, onReceived }: { onClose: () => void; onReceived: () => void }) {
  const [sku, setSku] = useState('')
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<ReceiveCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<ReceiveLogEntry[]>([])
  const inputRef = useCallback((el: HTMLInputElement | null) => { el?.focus() }, [])

  const reset = () => {
    setSku('')
    setQty(1)
    setCandidates(null)
    setError(null)
  }

  const lookupSku = async (skuValue: string, qtyValue: number) => {
    setBusy(true)
    setError(null)
    setCandidates(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/receive-candidates?sku=${encodeURIComponent(skuValue)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Lookup failed (${res.status})`)
      const list: ReceiveCandidate[] = data?.candidates ?? []
      if (list.length === 0) {
        setError(`No open shipment expects SKU "${skuValue}".`)
        setLog((prev) => [{ ts: Date.now(), sku: skuValue, shipmentRef: null, applied: 0, ok: false, message: 'No match' }, ...prev].slice(0, 10))
        setBusy(false)
        return
      }
      if (list.length === 1) {
        await applyReceive(list[0], qtyValue)
      } else {
        setCandidates(list)
        setBusy(false)
      }
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  const applyReceive = async (cand: ReceiveCandidate, qtyValue: number) => {
    setBusy(true)
    try {
      const target = Math.min(cand.quantityExpected, cand.quantityReceived + qtyValue)
      const idempotencyKey = `bulk-${cand.itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${cand.shipment.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor: 'bulk-receive',
          items: [{ itemId: cand.itemId, quantityReceived: target, idempotencyKey }],
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Receive failed (${res.status})`)
      const applied = target - cand.quantityReceived
      setLog((prev) => [
        { ts: Date.now(), sku: cand.sku, shipmentRef: cand.shipment.reference, applied, ok: true },
        ...prev,
      ].slice(0, 10))
      onReceived()
      reset()
    } catch (e: any) {
      setError(e.message)
      setLog((prev) => [{ ts: Date.now(), sku: cand.sku, shipmentRef: cand.shipment.reference, applied: 0, ok: false, message: e.message }, ...prev].slice(0, 10))
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const s = sku.trim()
    if (!s) return
    void lookupSku(s, Math.max(1, qty || 1))
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[14px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <ArrowDownToLine size={16} className="text-emerald-600" /> Bulk receive
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>

        <div className="p-5 space-y-3">
          <div className="text-[12px] text-slate-500">Scan or type a SKU. The system finds the right open shipment and applies +qty automatically. Bluetooth scanners work — just keep this input focused.</div>

          <form onSubmit={onSubmit} className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Scan SKU…"
                disabled={busy}
                className="flex-1 h-10 px-3 text-[14px] font-mono border-2 border-emerald-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-500"
              />
              <input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value) || 1)}
                disabled={busy}
                className="h-10 w-20 px-2 text-right tabular-nums text-[14px] border border-slate-200 rounded"
              />
              <button
                type="submit"
                disabled={busy || !sku.trim()}
                className="h-10 px-4 text-[12px] bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Check size={14} /> Receive
              </button>
            </div>
          </form>

          {error && (
            <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* Multi-candidate picker */}
          {candidates && candidates.length > 1 && (
            <div className="border border-amber-200 bg-amber-50 rounded p-3 space-y-2">
              <div className="text-[12px] font-semibold text-amber-900 inline-flex items-center gap-1.5">
                <AlertTriangle size={12} /> {candidates.length} shipments expect this SKU — pick one
              </div>
              <ul className="space-y-1.5">
                {candidates.map((c) => (
                  <li key={c.itemId}>
                    <button
                      onClick={() => applyReceive(c, qty)}
                      disabled={busy}
                      className="w-full text-left bg-white border border-slate-200 rounded p-2 hover:bg-emerald-50 hover:border-emerald-300 disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-mono text-slate-900 truncate">
                            {c.shipment.reference ?? c.shipment.id}
                            <span className="ml-2 text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{c.shipment.type}</span>
                            <span className="ml-1 text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{c.shipment.status}</span>
                          </div>
                          {c.productName && <div className="text-[11px] text-slate-500 truncate">{c.productName}</div>}
                        </div>
                        <div className="text-[11px] tabular-nums text-slate-600 flex-shrink-0">
                          {c.quantityReceived}/{c.quantityExpected} · {c.remaining} left
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Receive log */}
          {log.length > 0 && (
            <div className="border-t border-slate-200 pt-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">This session ({log.filter((l) => l.ok).reduce((n, l) => n + l.applied, 0)} units received)</div>
              <ul className="space-y-1">
                {log.map((entry, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className={`inline-flex items-center gap-1 ${entry.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {entry.ok ? <Check size={11} /> : <X size={11} />}
                      <span className="font-mono">{entry.sku}</span>
                    </span>
                    <span className="text-slate-500 truncate flex-1 mx-2">
                      {entry.ok
                        ? `+${entry.applied} into ${entry.shipmentRef ?? '?'}`
                        : (entry.message ?? 'Failed')}
                    </span>
                    <span className="text-slate-400 tabular-nums">{new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// FBAWizardModal — kept from B.5 with the H.0c "preview" honesty
// banner. Real SP-API integration lands in commits 8a–8d.
// ─────────────────────────────────────────────────────────────────────
// H.8b — small helper that calls the labels endpoint on demand
// (lazy: don't fetch until operator clicks). Renders the resulting
// Amazon-hosted PDF URL as a target-blank link. Refresh button
// re-fetches because Amazon's URL is short-lived (minutes).
function FbaLabelDownload({ shipmentId }: { shipmentId: string }) {
  const [labelType, setLabelType] = useState<'BARCODE_2D' | 'UNIQUE' | 'PALLET'>('BARCODE_2D')
  const [pageType, setPageType] = useState<'PackageLabel_A4_4' | 'PackageLabel_Letter_4' | 'PackageLabel_Thermal'>('PackageLabel_A4_4')
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchLabels = async () => {
    setBusy(true)
    setError(null)
    setDownloadUrl(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/shipments/${encodeURIComponent(shipmentId)}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageType, labelType }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
      setDownloadUrl(data?.downloadUrl ?? data?.labelsUrl ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Labels</div>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={labelType} onChange={(e) => setLabelType(e.target.value as any)} className="h-7 text-[11px] px-2 border border-slate-200 rounded">
          <option value="BARCODE_2D">FNSKU (unit)</option>
          <option value="UNIQUE">Carton</option>
          <option value="PALLET">Pallet</option>
        </select>
        <select value={pageType} onChange={(e) => setPageType(e.target.value as any)} className="h-7 text-[11px] px-2 border border-slate-200 rounded">
          <option value="PackageLabel_A4_4">A4 — 4 per sheet</option>
          <option value="PackageLabel_Letter_4">Letter — 4 per sheet</option>
          <option value="PackageLabel_Thermal">Thermal</option>
        </select>
        <button
          onClick={fetchLabels}
          disabled={busy}
          className="h-7 px-2.5 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy ? 'Fetching…' : downloadUrl ? 'Refresh' : 'Get labels →'}
        </button>
        {downloadUrl && (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="h-7 px-2.5 text-[11px] bg-emerald-600 text-white rounded hover:bg-emerald-700 inline-flex items-center gap-1"
          >
            <FileText size={11} /> Download PDF
          </a>
        )}
      </div>
      {error && <div className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{error}</div>}
      {downloadUrl && (
        <div className="text-[10px] text-slate-500">Amazon link expires in a few minutes — click "Refresh" to mint a new one.</div>
      )}
    </div>
  )
}

// H.8c — putTransportDetails. Operator picks SP (small parcel) or LTL
// (truck), enters carrier name + tracking IDs (one per box for SP) or
// PRO# (for LTL). Calls non-partnered endpoint — partnered (UPS via
// Amazon) is US/UK-centric and not on Xavia's path.
function FbaTransportBooking({ shipmentId }: { shipmentId: string }) {
  const [shipmentType, setShipmentType] = useState<'SP' | 'LTL'>('SP')
  const [carrierName, setCarrierName] = useState('OTHER')
  const [trackingInput, setTrackingInput] = useState('')
  const [proNumber, setProNumber] = useState('')
  const [transportStatus, setTransportStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setTransportStatus(null)
    try {
      const trackingIds = trackingInput.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      if (shipmentType === 'SP' && trackingIds.length === 0) {
        throw new Error('Enter at least one tracking ID (one per box).')
      }
      if (shipmentType === 'LTL' && !proNumber.trim()) {
        throw new Error('PRO# is required for LTL shipments.')
      }
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/shipments/${encodeURIComponent(shipmentId)}/transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipmentType,
          carrierName: carrierName.trim() || 'OTHER',
          ...(shipmentType === 'SP' ? { trackingIds } : { proNumber: proNumber.trim() }),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`)
      setTransportStatus(data?.transportStatus ?? 'WORKING')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Transport</div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={shipmentType}
          onChange={(e) => setShipmentType(e.target.value as 'SP' | 'LTL')}
          className="h-7 text-[11px] px-2 border border-slate-200 rounded"
        >
          <option value="SP">Small parcel</option>
          <option value="LTL">LTL (truck)</option>
        </select>
        <input
          type="text"
          value={carrierName}
          onChange={(e) => setCarrierName(e.target.value)}
          placeholder="Carrier (e.g. DHL, UPS, OTHER)"
          className="h-7 text-[11px] px-2 border border-slate-200 rounded w-40"
        />
        {shipmentType === 'SP' ? (
          <input
            type="text"
            value={trackingInput}
            onChange={(e) => setTrackingInput(e.target.value)}
            placeholder="Tracking IDs (comma-separated, one per box)"
            className="h-7 text-[11px] px-2 border border-slate-200 rounded flex-1 min-w-[180px] font-mono"
          />
        ) : (
          <input
            type="text"
            value={proNumber}
            onChange={(e) => setProNumber(e.target.value)}
            placeholder="PRO#"
            className="h-7 text-[11px] px-2 border border-slate-200 rounded w-32 font-mono"
          />
        )}
        <button
          onClick={submit}
          disabled={busy}
          className="h-7 px-2.5 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Booking…' : transportStatus ? 'Re-book' : 'Book transport →'}
        </button>
        {transportStatus && (
          <span className="text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">
            {transportStatus}
          </span>
        )}
      </div>
      {error && <div className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{error}</div>}
    </div>
  )
}

// H.9 — Catalog-aware SKU picker for the FBA wizard. Replaces the
// hand-typed SKU input with autocomplete against /api/products,
// inline product preview (thumbnail, name, totalStock as a proxy
// for current FBA inventory), and click-to-remove. The wizard still
// works with the same { sku, quantity } shape downstream — the
// picker just enriches the rows with name/imageUrl/totalStock for
// display and is a drop-in for the old typed-input flow.
//
// Why /api/products and not a dedicated endpoint: the catalog list
// already supports `search` + `limit` and returns exactly the
// fields we need (sku, name, imageUrl, totalStock). No reason to
// fork an FBA-specific search.
type FbaPickerItem = {
  sku: string
  quantity: number
  productId?: string
  name?: string
  imageUrl?: string | null
  totalStock?: number | null
}

function FbaSkuPicker({
  items,
  onChange,
}: {
  items: FbaPickerItem[]
  onChange: (next: FbaPickerItem[]) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{
    id: string; sku: string; name: string; imageUrl: string | null; totalStock: number | null
  }>>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  // Debounced search. 250ms is the sweet spot for keystroke→results
  // on a list endpoint; faster floods the API, slower feels laggy.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/products?search=${encodeURIComponent(q)}&limit=8`)
        const data = await res.json().catch(() => ({}))
        setResults(
          (data?.products ?? []).map((p: any) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            imageUrl: p.imageUrl,
            totalStock: typeof p.totalStock === 'number' ? p.totalStock : null,
          })),
        )
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [query])

  const addProduct = (p: typeof results[number]) => {
    // Don't add a SKU twice — bump the existing row's quantity instead.
    const existingIdx = items.findIndex((it) => it.sku === p.sku)
    if (existingIdx >= 0) {
      onChange(items.map((it, i) => i === existingIdx ? { ...it, quantity: it.quantity + 1 } : it))
    } else {
      onChange([
        ...items.filter((it) => it.sku.trim()), // drop any blank rows
        { sku: p.sku, quantity: 1, productId: p.id, name: p.name, imageUrl: p.imageUrl, totalStock: p.totalStock },
      ])
    }
    setQuery('')
    setResults([])
    setOpen(false)
  }

  const updateQty = (idx: number, qty: number) => {
    onChange(items.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, qty || 1) } : it))
  }

  const removeRow = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx))
  }

  const realRows = items.filter((it) => it.sku.trim())

  return (
    <div className="space-y-3">
      {/* Autocomplete search */}
      <div className="relative">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            placeholder="Search SKU or product name…"
            className="w-full h-9 pl-8 pr-3 text-[12px] border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-orange-200 focus:border-orange-400"
          />
        </div>
        {open && query.trim().length >= 2 && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded shadow-lg max-h-72 overflow-y-auto">
            {loading && <div className="px-3 py-2 text-[11px] text-slate-500">Searching…</div>}
            {!loading && results.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-slate-500">No products match "{query.trim()}"</div>
            )}
            {!loading && results.map((p) => (
              <button
                key={p.id}
                onMouseDown={(e) => { e.preventDefault(); addProduct(p) }}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-orange-50 border-b border-slate-100 last:border-b-0"
              >
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" className="h-9 w-9 rounded object-cover bg-slate-100 flex-shrink-0" />
                ) : (
                  <div className="h-9 w-9 rounded bg-slate-100 flex items-center justify-center flex-shrink-0">
                    <Boxes size={14} className="text-slate-400" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-mono text-slate-700 truncate">{p.sku}</div>
                  <div className="text-[12px] text-slate-900 truncate">{p.name}</div>
                </div>
                {p.totalStock != null && (
                  <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
                    p.totalStock <= 0
                      ? 'bg-rose-50 text-rose-700 border border-rose-200'
                      : p.totalStock < 10
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  }`}>
                    {p.totalStock} in FBA
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected rows */}
      {realRows.length === 0 ? (
        <div className="text-[11px] text-slate-500 italic px-2 py-3 border border-dashed border-slate-200 rounded bg-slate-50 text-center">
          No SKUs added yet. Search above and click a result to add it.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((row, i) => row.sku.trim() ? (
            <li key={`${row.sku}-${i}`} className="flex items-center gap-2 p-2 border border-slate-200 rounded bg-white">
              {row.imageUrl ? (
                <img src={row.imageUrl} alt="" className="h-9 w-9 rounded object-cover bg-slate-100 flex-shrink-0" />
              ) : (
                <div className="h-9 w-9 rounded bg-slate-100 flex items-center justify-center flex-shrink-0">
                  <Boxes size={14} className="text-slate-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-mono text-slate-700 truncate">{row.sku}</div>
                {row.name && <div className="text-[12px] text-slate-900 truncate">{row.name}</div>}
              </div>
              {row.totalStock != null && (
                <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded flex-shrink-0 ${
                  row.totalStock <= 0
                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                    : row.totalStock < 10
                      ? 'bg-amber-50 text-amber-700 border border-amber-200'
                      : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                }`}>
                  {row.totalStock} in FBA
                </span>
              )}
              <input
                type="number"
                min="1"
                value={row.quantity}
                onChange={(e) => updateQty(i, Number(e.target.value))}
                className="h-7 w-16 px-2 text-right tabular-nums text-[12px] border border-slate-200 rounded flex-shrink-0"
              />
              <button
                onClick={() => removeRow(i)}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600 flex-shrink-0"
                aria-label="Remove"
              >
                <X size={14} />
              </button>
            </li>
          ) : null)}
        </ul>
      )}
    </div>
  )
}

function FBAWizardModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<'plan' | 'commit'>('plan')
  const [items, setItems] = useState<FbaPickerItem[]>([])
  const [plan, setPlan] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const buildPlan = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/plan-shipment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.filter((i) => i.sku.trim()) }),
      })
      if (!res.ok) throw new Error('Plan failed')
      setPlan(await res.json())
      setStep('commit')
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  const commit = async () => {
    if (!plan?.shipmentPlans?.length) return
    const sp = plan.shipmentPlans[0]
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/create-shipment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipmentId: sp.shipmentId,
          destinationFC: sp.destinationFC,
          name: `Send to ${sp.destinationFC}`,
          items: sp.items,
        }),
      })
      if (!res.ok) throw new Error('Create failed')
      onCreated()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <Truck size={16} className="text-orange-600" /> Send to Amazon FBA
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>

        {/* H.8d status banner — Plan + Labels + Status polling are
            real against SP-API v0; putTransportDetails is deprecated
            on v0 (Amazon returns 400 with a v2024-03-20 migration
            note). Honest banner reflects that. */}
        <div className="mx-5 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-900">
          <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
            Plan + Labels + Status polling live · Transport v0 deprecated by Amazon
          </div>
          <div className="text-amber-800 leading-snug">
            createInboundShipmentPlan, getLabels (FNSKU/carton/pallet), and the
            15-min status-polling cron submit to Amazon SP-API v0 for real.
            putTransportDetails on v0 is deprecated (Amazon returns 400) — until
            we migrate the inbound surface to v2024-03-20, transport booking
            must be completed in Seller Central. See TECH_DEBT #50.
          </div>
        </div>

        {step === 'plan' && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">Step 1 of 2 — pick the SKUs and quantities to ship to Amazon. Search by SKU or product name.</div>
            <FbaSkuPicker items={items} onChange={setItems} />
            <footer className="pt-3 border-t border-slate-200 flex items-center gap-2 justify-end">
              <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
              <button
                onClick={buildPlan}
                disabled={busy || items.filter((i) => i.sku.trim()).length === 0}
                className="h-8 px-3 text-[12px] bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
              >
                Plan shipment →
              </button>
            </footer>
          </div>
        )}

        {step === 'commit' && plan && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">Step 2 of 2 — Amazon-issued shipment IDs below. Confirm to write local records, then download FNSKU labels for each shipment.</div>
            {plan.shipmentPlans.map((sp: any, i: number) => (
              <div key={i} className="border border-slate-200 rounded-md p-3">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                  <div className="text-[12px] font-semibold text-slate-900 font-mono">{sp.shipmentId}</div>
                  <span className="text-[11px] font-mono bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded">→ {sp.destinationFC}</span>
                </div>
                <ul className="space-y-1">
                  {sp.items.map((it: any, j: number) => (
                    <li key={j} className="flex items-center justify-between text-[12px]">
                      <span className="font-mono text-slate-700">{it.sku}</span>
                      <span className="tabular-nums text-slate-600">×{it.quantity}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 pt-2 border-t border-slate-100 space-y-3">
                  <FbaLabelDownload shipmentId={sp.shipmentId} />
                  <FbaTransportBooking shipmentId={sp.shipmentId} />
                </div>
              </div>
            ))}
            <footer className="pt-3 border-t border-slate-200 flex items-center gap-2 justify-end">
              <button onClick={() => setStep('plan')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Back</button>
              <button onClick={commit} disabled={busy} className="h-8 px-3 text-[12px] bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">Create shipment</button>
            </footer>
          </div>
        )}
      </div>
    </div>
  )
}
