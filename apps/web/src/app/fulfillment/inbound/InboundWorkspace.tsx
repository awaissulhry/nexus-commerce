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
} from 'lucide-react'
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
  }, [tab, status, search, page, sortBy, sortDir])

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
    () => [tab !== 'ALL', status, search].filter(Boolean).length,
    [tab, status, search],
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
            {filterCount > 0 && (
              <button
                onClick={() => updateUrl({ type: undefined, status: undefined, search: undefined, page: undefined })}
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
            ? { label: 'Clear filters', onClick: () => updateUrl({ type: undefined, status: undefined, search: undefined, page: undefined }) }
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
                          <span className={isLate ? 'text-rose-700 font-semibold' : 'text-slate-600'}>
                            {eta.toLocaleDateString('en-GB')}
                            {isLate && <span className="ml-1 text-[10px]">late</span>}
                          </span>
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
      label: 'Arriving (7d)',
      value: kpis.arrivingThisWeek.toLocaleString(),
      detail: `Within next week`,
      tone: kpis.arrivingThisWeek > 0 ? 'bg-violet-50 text-violet-600' : 'bg-slate-50 text-slate-600',
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
function InboundDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [shipment, setShipment] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [receiveBuf, setReceiveBuf] = useState<Record<string, { qty: number; qc: string }>>({})

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
      .filter(([, v]) => v.qty > 0)
      .map(([itemId, v]) => ({ itemId, quantityReceived: v.qty, qcStatus: v.qc || undefined }))
    if (updates.length === 0) { alert('Enter received quantities'); return }
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: updates }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return alert(err.error ?? 'Receive failed')
    }
    setReceiveBuf({})
    setShipment(await res.json())
    onChanged()
  }

  const transition = async (status: string) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return alert(err.error ?? 'Transition failed')
    }
    fetchOne()
    onChanged()
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900">Inbound shipment</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {loading || !shipment ? <div className="text-[12px] text-slate-500">Loading…</div> : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${TYPE_TONE[shipment.type as InboundType]}`}>{shipment.type}</span>
                <Badge variant={STATUS_VARIANT[shipment.status as InboundStatus] ?? 'default'} size="sm">{shipment.status.replace(/_/g, ' ')}</Badge>
                {shipment.reference && <span className="text-[12px] text-slate-500 font-mono">{shipment.reference}</span>}
              </div>

              {/* Carrier + tracking */}
              {(shipment.carrierCode || shipment.trackingNumber) && (
                <div className="border border-slate-200 rounded-md p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Carrier</div>
                  <CarrierLink carrierCode={shipment.carrierCode} trackingNumber={shipment.trackingNumber} trackingUrl={shipment.trackingUrl} />
                  {shipment.expectedAt && (
                    <div className="text-[11px] text-slate-500 mt-1">
                      ETA {new Date(shipment.expectedAt).toLocaleDateString('en-GB')}
                    </div>
                  )}
                </div>
              )}

              {/* Costs (when any set) */}
              {(shipment.shippingCostCents || shipment.customsCostCents || shipment.dutiesCostCents || shipment.insuranceCostCents) && (
                <div className="border border-slate-200 rounded-md p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Landed cost ({shipment.currencyCode})</div>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    {shipment.shippingCostCents != null && <div><span className="text-slate-500">Shipping</span> <span className="font-semibold tabular-nums float-right">{(shipment.shippingCostCents / 100).toFixed(2)}</span></div>}
                    {shipment.customsCostCents != null && <div><span className="text-slate-500">Customs</span> <span className="font-semibold tabular-nums float-right">{(shipment.customsCostCents / 100).toFixed(2)}</span></div>}
                    {shipment.dutiesCostCents != null && <div><span className="text-slate-500">Duties</span> <span className="font-semibold tabular-nums float-right">{(shipment.dutiesCostCents / 100).toFixed(2)}</span></div>}
                    {shipment.insuranceCostCents != null && <div><span className="text-slate-500">Insurance</span> <span className="font-semibold tabular-nums float-right">{(shipment.insuranceCostCents / 100).toFixed(2)}</span></div>}
                  </div>
                </div>
              )}

              {/* Items */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Items</div>
                <table className="w-full text-[12px]">
                  <thead className="border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">SKU</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Expected</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Received</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Receive now</th>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">QC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipment.items.map((it: any) => (
                      <tr key={it.id} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 font-mono text-slate-700">{it.sku}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{it.quantityExpected}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{it.quantityReceived}</td>
                        <td className="px-2 py-1.5 text-right">
                          <input
                            type="number"
                            min="0"
                            value={receiveBuf[it.id]?.qty ?? ''}
                            onChange={(e) => setReceiveBuf({ ...receiveBuf, [it.id]: { qty: Number(e.target.value) || 0, qc: receiveBuf[it.id]?.qc ?? '' } })}
                            className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={receiveBuf[it.id]?.qc ?? ''}
                            onChange={(e) => setReceiveBuf({ ...receiveBuf, [it.id]: { qty: receiveBuf[it.id]?.qty ?? 0, qc: e.target.value } })}
                            className="h-7 px-2 text-[12px] border border-slate-200 rounded"
                          >
                            <option value="">—</option>
                            <option value="PASS">PASS</option>
                            <option value="HOLD">HOLD</option>
                            <option value="FAIL">FAIL</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Discrepancies + attachments summary (full surfaces in Commit 6) */}
              {(shipment.discrepancies?.length > 0 || shipment.attachments?.length > 0) && (
                <div className="grid grid-cols-2 gap-3 text-[11px]">
                  {shipment.discrepancies?.length > 0 && (
                    <div className="border border-slate-200 rounded-md p-2.5">
                      <div className="uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
                        <AlertTriangle size={11} className="text-rose-500" />
                        Discrepancies ({shipment.discrepancies.length})
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {shipment.discrepancies.slice(0, 3).map((d: any) => (
                          <li key={d.id} className="text-slate-600">
                            <span className="font-mono">{d.reasonCode}</span> · {d.status}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {shipment.attachments?.length > 0 && (
                    <div className="border border-slate-200 rounded-md p-2.5">
                      <div className="uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
                        <FileText size={11} className="text-slate-500" />
                        Attachments ({shipment.attachments.length})
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {shipment.attachments.slice(0, 3).map((a: any) => (
                          <li key={a.id} className="text-slate-600 truncate">
                            <span className="font-mono">{a.kind}</span> · {a.filename ?? a.url}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-3 border-t border-slate-100 flex-wrap">
                <button onClick={submitReceive} className="h-8 px-3 text-[12px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
                  <ArrowDownToLine size={12} /> Receive units
                </button>
                {/* Status transitions — surface only the legal next states */}
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
                  <button onClick={() => { if (confirm('Cancel shipment?')) transition('CANCELLED') }} className="h-8 px-3 text-[12px] text-rose-700 hover:bg-rose-50 rounded">Cancel</button>
                )}
                {shipment.fbaShipmentId && (
                  <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                    FBA detail page lands in 8a
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// CreateInboundModal — kept from B.5/B.6, untouched so existing flow
// continues to work. Accepts new H.1 fields where the form is wired.
// Rebuild (CSV import + ASN parse + multi-currency form) lands in Commit 4.
// ─────────────────────────────────────────────────────────────────────
function CreateInboundModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [type, setType] = useState<'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'>('SUPPLIER')
  const [reference, setReference] = useState('')
  const [skus, setSkus] = useState<Array<{ sku: string; quantityExpected: number }>>([{ sku: '', quantityExpected: 1 }])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type, reference,
          items: skus.filter((s) => s.sku.trim()),
        }),
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
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900">New inbound shipment</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Type</div>
            <div className="flex items-center gap-2">
              {(['SUPPLIER', 'MANUFACTURING', 'TRANSFER'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)} className={`h-7 px-3 text-[11px] border rounded ${type === t ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200'}`}>{t}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Reference</div>
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Supplier invoice #, transport doc, …" className="h-8 w-full px-2 text-[13px] border border-slate-200 rounded" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Items</div>
            <div className="space-y-1.5">
              {skus.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setSkus(skus.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-[12px] font-mono border border-slate-200 rounded" />
                  <input type="number" min="1" value={row.quantityExpected} onChange={(e) => setSkus(skus.map((s, j) => j === i ? { ...s, quantityExpected: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded" />
                  <button onClick={() => setSkus(skus.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setSkus([...skus, { sku: '', quantityExpected: 1 }])} className="mt-2 text-[11px] text-blue-600 hover:underline">+ Add SKU</button>
          </div>
          <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
            Carrier + tracking + multi-currency cost capture surface in Commit 4. Saving here creates a DRAFT inbound; transition to SUBMITTED from the drawer.
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 justify-end">
          <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create</button>
        </footer>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// FBAWizardModal — kept from B.5 with the H.0c "preview" honesty
// banner. Real SP-API integration lands in commits 8a–8d.
// ─────────────────────────────────────────────────────────────────────
function FBAWizardModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<'plan' | 'commit'>('plan')
  const [items, setItems] = useState<Array<{ sku: string; quantity: number; productId?: string }>>([{ sku: '', quantity: 1 }])
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

        {/* H.0c — honesty banner */}
        <div className="mx-5 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-900">
          <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
            Preview — does not submit to Amazon yet
          </div>
          <div className="text-amber-800 leading-snug">
            This wizard writes Nexus-side records but the real SP-API integration ships in upcoming commits 8a–8d. Use it to dry-run the flow only.
          </div>
        </div>

        {step === 'plan' && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">Step 1 of 2 — list the SKUs and quantities to ship to Amazon.</div>
            <div className="space-y-1.5">
              {items.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-[12px] font-mono border border-slate-200 rounded" />
                  <input type="number" min="1" value={row.quantity} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, quantity: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded" />
                  <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, { sku: '', quantity: 1 }])} className="text-[11px] text-blue-600 hover:underline">+ Add SKU</button>
            <footer className="pt-3 border-t border-slate-200 flex items-center gap-2 justify-end">
              <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
              <button onClick={buildPlan} disabled={busy} className="h-8 px-3 text-[12px] bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">Plan shipment →</button>
            </footer>
          </div>
        )}

        {step === 'commit' && plan && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">Step 2 of 2 — confirm and Nexus will create local records (Amazon submit lands in 8a).</div>
            {plan.shipmentPlans.map((sp: any, i: number) => (
              <div key={i} className="border border-slate-200 rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[12px] font-semibold text-slate-900">FBA shipment {sp.shipmentId}</div>
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
