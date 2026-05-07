'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Loader2,
  Package,
  Printer,
  RefreshCw,
  Warehouse as WarehouseIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types (mirror /api/fulfillment/pick-list response) ─────────────

interface PickItem {
  shipmentItemId: string
  productId: string | null
  sku: string
  productName: string | null
  weightValue: number | null
  weightUnit: string | null
  quantity: number
  location: {
    locationCode: string
    onHand: number
    available: number
  } | null
}

interface PickShipment {
  shipmentId: string
  status: string
  orderId: string | null
  orderRef: string
  orderChannel: string | null
  customerName: string | null
  createdAt: string
  carrierCode: string
  weightGrams: number | null
  itemCount: number
  totalUnits: number
  items: PickItem[]
}

interface PickWarehouse {
  warehouseId: string | null
  code: string
  name: string
  shipmentCount: number
  shipments: PickShipment[]
}

interface PickListResponse {
  success: boolean
  warehouses: PickWarehouse[]
  totals: {
    warehouses: number
    shipments: number
    items: number
    units: number
  }
  statusFilter: string[]
}

// ── Status filter chips ────────────────────────────────────────────

type StatusFilter = 'pickable' | 'all' | 'DRAFT' | 'READY_TO_PICK'
const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; statuses: string[] }> = [
  { key: 'pickable', label: 'Pickable', statuses: ['DRAFT', 'READY_TO_PICK'] },
  { key: 'DRAFT', label: 'Draft only', statuses: ['DRAFT'] },
  { key: 'READY_TO_PICK', label: 'Ready only', statuses: ['READY_TO_PICK'] },
]

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// ── Per-shipment row ───────────────────────────────────────────────

function ShipmentBlock({
  shipment,
  onMarkPicked,
}: {
  shipment: PickShipment
  onMarkPicked: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState(true)
  const [picking, setPicking] = useState(false)
  const [pickedItems, setPickedItems] = useState<Set<string>>(new Set())

  const allChecked = pickedItems.size === shipment.items.length
  const togglePicked = (itemId: string) => {
    setPickedItems((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const handleMarkPicked = async () => {
    setPicking(true)
    try {
      await onMarkPicked()
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden print:break-inside-avoid print:shadow-none">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 transition-colors text-left print:cursor-default"
      >
        <div className="flex-shrink-0 print:hidden">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </div>
        <Package className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-medium text-slate-900 text-md">
              {shipment.orderRef}
            </span>
            <Badge variant="info" size="sm">
              {shipment.status.replace(/_/g, ' ')}
            </Badge>
            {shipment.orderChannel && (
              <Badge variant="default" size="sm">
                {shipment.orderChannel}
              </Badge>
            )}
            <Badge variant="default" size="sm">
              {shipment.carrierCode}
            </Badge>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-sm text-slate-500 flex-wrap">
            {shipment.customerName && (
              <span className="truncate max-w-[260px]">{shipment.customerName}</span>
            )}
            <span>·</span>
            <span>
              {shipment.itemCount} {shipment.itemCount === 1 ? 'line' : 'lines'} · {shipment.totalUnits} units
            </span>
            <span>·</span>
            <span title={new Date(shipment.createdAt).toLocaleString()}>
              {relativeTime(shipment.createdAt)}
            </span>
            {pickedItems.size > 0 && (
              <span className="text-green-700 font-medium">
                · {pickedItems.size}/{shipment.items.length} picked
              </span>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 print:border-t-2 print:border-slate-400">
          <table className="w-full text-base">
            <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200 print:bg-white">
              <tr>
                <th className="text-left font-medium px-3 py-1.5 w-8 print:hidden"></th>
                <th className="text-left font-medium px-3 py-1.5 w-28">Location</th>
                <th className="text-left font-medium px-3 py-1.5">SKU / Product</th>
                <th className="text-right font-medium px-3 py-1.5 w-16">Qty</th>
                <th className="text-right font-medium px-3 py-1.5 w-24 print:hidden">On hand</th>
              </tr>
            </thead>
            <tbody>
              {shipment.items.map((it) => {
                const isPicked = pickedItems.has(it.shipmentItemId)
                const lowStock =
                  it.location && it.location.available < it.quantity
                return (
                  <tr
                    key={it.shipmentItemId}
                    className={cn(
                      'border-b border-slate-100 last:border-0 align-top',
                      isPicked && 'bg-green-50/50',
                    )}
                  >
                    <td className="px-3 py-1.5 print:hidden">
                      <button
                        type="button"
                        onClick={() => togglePicked(it.shipmentItemId)}
                        className={cn(
                          'w-5 h-5 rounded border flex items-center justify-center transition-colors',
                          isPicked
                            ? 'bg-green-600 border-green-600 text-white'
                            : 'bg-white border-slate-300 hover:border-slate-400',
                        )}
                        aria-label={isPicked ? 'Mark unpicked' : 'Mark picked'}
                      >
                        {isPicked && <Check className="w-3 h-3" />}
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      {it.location ? (
                        <span className="font-mono text-sm inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 rounded">
                          {it.location.locationCode}
                        </span>
                      ) : (
                        <span className="text-xs italic text-amber-700">
                          unlocated
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="font-mono text-sm text-slate-900">
                        {it.sku}
                      </div>
                      {it.productName && (
                        <div className="text-sm text-slate-500 truncate max-w-md">
                          {it.productName}
                        </div>
                      )}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right tabular-nums font-semibold',
                        lowStock && 'text-red-700',
                      )}
                    >
                      {it.quantity}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sm text-slate-500 print:hidden">
                      {it.location ? (
                        <span
                          className={cn(
                            lowStock && 'text-red-700 font-medium',
                          )}
                          title={
                            lowStock
                              ? `Available (${it.location.available}) is below requested qty (${it.quantity})`
                              : undefined
                          }
                        >
                          {it.location.available}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between print:hidden">
            <div className="text-sm text-slate-500">
              {pickedItems.size === 0
                ? 'Tick items as you pick them; mark the shipment when complete'
                : allChecked
                  ? 'All items picked — ready to advance shipment'
                  : `${pickedItems.size}/${shipment.items.length} items checked`}
            </div>
            <button
              type="button"
              onClick={handleMarkPicked}
              disabled={picking}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 text-base font-medium rounded border transition-colors disabled:opacity-50',
                allChecked
                  ? 'bg-green-600 text-white border-green-600 hover:bg-green-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50',
              )}
            >
              {picking ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              Mark shipment picked
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Top-level client ───────────────────────────────────────────────

export default function PickListClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const urlStatus = (searchParams.get('status') ?? 'pickable') as StatusFilter
  const validStatuses = useMemo(
    () => new Set(STATUS_FILTERS.map((f) => f.key)),
    [],
  )
  const statusFilter: StatusFilter = validStatuses.has(urlStatus)
    ? urlStatus
    : 'pickable'
  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'pickable') params.delete('status')
      else params.set('status', next)
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const [data, setData] = useState<PickListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const filterDef = STATUS_FILTERS.find((f) => f.key === statusFilter)
      const url = new URL(`${getBackendUrl()}/api/fulfillment/pick-list`)
      url.searchParams.set('status', (filterDef?.statuses ?? ['DRAFT', 'READY_TO_PICK']).join(','))
      url.searchParams.set('limit', '200')
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleMarkPicked = useCallback(
    async (shipmentId: string, orderRef: string) => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/pick-list/${shipmentId}/picked`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(`Picked: ${orderRef}`)
        await fetchData()
      } catch (err) {
        toast.error(
          `Mark picked failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    [fetchData, toast],
  )

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="space-y-3">
      {/* Filter bar (hidden in print) */}
      <div className="flex items-center justify-between gap-2 flex-wrap print:hidden">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'px-3 py-1 text-sm font-medium rounded border transition-colors',
                statusFilter === f.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={handlePrint}>
            <Printer className="w-3.5 h-3.5" />
            Print
          </Button>
        </div>
      </div>

      {/* Totals strip (visible in print, marks the doc) */}
      {data && data.totals.shipments > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-base text-slate-700 flex items-center gap-4 flex-wrap print:bg-white print:border-none print:px-0 print:text-md">
          <ClipboardList className="w-4 h-4 text-blue-700 flex-shrink-0 print:hidden" />
          <span>
            <span className="font-semibold text-slate-900">{data.totals.shipments}</span>{' '}
            shipments
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-slate-900">{data.totals.units}</span> units
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-slate-900">{data.totals.warehouses}</span>{' '}
            warehouses
          </span>
          <span className="ml-auto text-sm text-slate-500 hidden print:inline">
            Generated {new Date().toLocaleString()}
          </span>
        </div>
      )}

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2 print:hidden">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-32 bg-white border border-slate-200 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {data && data.warehouses.length === 0 && !loading && (
        <EmptyState
          icon={ClipboardList}
          title="Nothing to pick"
          description={
            statusFilter === 'pickable'
              ? 'No DRAFT or READY_TO_PICK shipments. New orders will appear here once a shipment is created.'
              : 'No shipments match this filter.'
          }
        />
      )}

      {data && data.warehouses.length > 0 && (
        <div className="space-y-6">
          {data.warehouses.map((w) => (
            <div key={w.warehouseId ?? 'no-wh'} className="space-y-2">
              <div className="flex items-center gap-2 text-md font-semibold text-slate-900 print:text-lg">
                <WarehouseIcon className="w-4 h-4 text-slate-500" />
                {w.name}
                <span className="text-sm font-normal text-slate-500">
                  ({w.code} · {w.shipmentCount}{' '}
                  {w.shipmentCount === 1 ? 'shipment' : 'shipments'})
                </span>
              </div>
              <div className="space-y-2">
                {w.shipments.map((s) => (
                  <ShipmentBlock
                    key={s.shipmentId}
                    shipment={s}
                    onMarkPicked={() => handleMarkPicked(s.shipmentId, s.orderRef)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
