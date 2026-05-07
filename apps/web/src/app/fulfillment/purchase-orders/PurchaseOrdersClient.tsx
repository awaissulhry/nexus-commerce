'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCheck2,
  FileText,
  Loader2,
  PackageCheck,
  RefreshCw,
  Send,
  ShoppingCart,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types (mirror PO API response) ─────────────────────────────────

interface POItem {
  id: string
  productId: string | null
  sku: string
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
}

interface PORow {
  id: string
  poNumber: string
  supplierId: string | null
  supplier: { id: string; name: string } | null
  warehouseId: string | null
  warehouse: { code: string } | null
  status:
    | 'DRAFT'
    | 'REVIEW'
    | 'APPROVED'
    | 'SUBMITTED'
    | 'ACKNOWLEDGED'
    | 'CONFIRMED'
    | 'PARTIAL'
    | 'RECEIVED'
    | 'CANCELLED'
  totalCents: number
  currencyCode: string
  notes: string | null
  expectedDeliveryDate: string | null
  reviewedAt: string | null
  reviewedByUserId: string | null
  approvedAt: string | null
  approvedByUserId: string | null
  submittedAt: string | null
  submittedByUserId: string | null
  acknowledgedAt: string | null
  cancelledAt: string | null
  cancelledReason: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  items: POItem[]
}

interface AuditEntry {
  status: string
  at: string
  byUserId: string | null
  reason?: string | null
}

// ── Filter chips ───────────────────────────────────────────────────

type StatusFilter =
  | 'all'
  | 'active'
  | 'DRAFT'
  | 'REVIEW'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'RECEIVED'
  | 'CANCELLED'

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'REVIEW', label: 'In Review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { key: 'RECEIVED', label: 'Received' },
  { key: 'CANCELLED', label: 'Cancelled' },
]

// "active" means anything pre-terminal that needs operator attention.
const ACTIVE_STATUSES = new Set([
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SUBMITTED',
])

// ── Status presentation ────────────────────────────────────────────

function statusVariant(
  status: string,
): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'ACKNOWLEDGED':
    case 'RECEIVED':
    case 'CONFIRMED':
      return 'success'
    case 'SUBMITTED':
    case 'APPROVED':
      return 'info'
    case 'REVIEW':
    case 'PARTIAL':
      return 'warning'
    case 'CANCELLED':
      return 'danger'
    case 'DRAFT':
    default:
      return 'default'
  }
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  const cls = cn('w-3.5 h-3.5', className)
  switch (status) {
    case 'DRAFT':
      return <FileText className={cn(cls, 'text-slate-500')} />
    case 'REVIEW':
      return <Clock className={cn(cls, 'text-amber-600')} />
    case 'APPROVED':
      return <FileCheck2 className={cn(cls, 'text-blue-600')} />
    case 'SUBMITTED':
      return <Send className={cn(cls, 'text-blue-600')} />
    case 'ACKNOWLEDGED':
    case 'CONFIRMED':
      return <CheckCircle2 className={cn(cls, 'text-green-600')} />
    case 'PARTIAL':
      return <PackageCheck className={cn(cls, 'text-amber-600')} />
    case 'RECEIVED':
      return <PackageCheck className={cn(cls, 'text-green-600')} />
    case 'CANCELLED':
      return <Ban className={cn(cls, 'text-red-600')} />
    default:
      return <Clock className={cls} />
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function formatCurrency(cents: number, code: string): string {
  const amount = cents / 100
  // Best-effort Intl formatting; falls back if currencyCode is invalid.
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${code}`
  }
}

// What transitions are available from a given status — mirrors
// po-workflow.service.ts:nextStatus(). Keep in sync if the backend
// state machine changes.
function availableTransitions(
  status: string,
): Array<{
  key: 'submit-for-review' | 'approve' | 'send' | 'acknowledge' | 'cancel'
  label: string
  variant: 'primary' | 'secondary' | 'danger'
  icon: typeof Send
  destructive?: boolean
}> {
  switch (status) {
    case 'DRAFT':
      return [
        { key: 'submit-for-review', label: 'Submit for review', variant: 'primary', icon: ChevronRight },
        { key: 'cancel', label: 'Cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'REVIEW':
      return [
        { key: 'approve', label: 'Approve', variant: 'primary', icon: FileCheck2 },
        { key: 'cancel', label: 'Cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'APPROVED':
      return [
        { key: 'send', label: 'Send to supplier', variant: 'primary', icon: Send },
        { key: 'cancel', label: 'Cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'SUBMITTED':
      return [
        { key: 'acknowledge', label: 'Mark acknowledged', variant: 'primary', icon: CheckCircle2 },
      ]
    default:
      return []
  }
}

// ── Audit trail panel ──────────────────────────────────────────────

function AuditTrailPanel({ poId }: { poId: string }) {
  const [trail, setTrail] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTrail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/audit`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTrail(data.trail ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [poId])

  useEffect(() => {
    fetchTrail()
  }, [fetchTrail])

  if (loading) {
    return (
      <div className="text-base text-slate-500 inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading audit trail…
      </div>
    )
  }
  if (error) {
    return (
      <div className="text-base text-red-700">Audit unavailable: {error}</div>
    )
  }
  if (!trail || trail.length === 0) {
    return (
      <div className="text-base text-slate-500">No transitions recorded.</div>
    )
  }

  return (
    <div className="space-y-1.5">
      {trail.map((entry, idx) => (
        <div
          key={`${entry.status}-${entry.at}-${idx}`}
          className="flex items-center gap-2 text-sm"
        >
          <StatusIcon status={entry.status} className="w-3 h-3" />
          <Badge variant={statusVariant(entry.status)} size="sm">
            {entry.status.replace(/_/g, ' ')}
          </Badge>
          <span className="text-slate-500" title={new Date(entry.at).toLocaleString()}>
            {relativeTime(entry.at)}
          </span>
          {entry.byUserId && (
            <span className="text-slate-500">· {entry.byUserId}</span>
          )}
          {entry.reason && (
            <span className="text-slate-500">· {entry.reason}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Per-PO card (expandable) ───────────────────────────────────────

function PoCard({
  po,
  onTransition,
}: {
  po: PORow
  onTransition: (poId: string, transition: string, reason?: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [transitioning, setTransitioning] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const transitions = availableTransitions(po.status)
  const itemCount = po.items.length
  const totalUnits = po.items.reduce((s, i) => s + i.quantityOrdered, 0)

  const handleTransition = async (
    transitionKey: string,
    requireReason = false,
  ) => {
    if (requireReason && !cancelReason.trim()) {
      setShowCancelConfirm(true)
      return
    }
    setTransitioning(transitionKey)
    try {
      await onTransition(po.id, transitionKey, cancelReason.trim() || undefined)
      setShowCancelConfirm(false)
      setCancelReason('')
    } finally {
      setTransitioning(null)
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-3 flex items-center gap-4 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          )}
        </div>
        <StatusIcon status={po.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-mono font-medium text-slate-900 text-md">
              {po.poNumber}
            </h3>
            <Badge variant={statusVariant(po.status)} size="sm">
              {po.status.replace(/_/g, ' ')}
            </Badge>
            {po.supplier ? (
              <span className="text-base text-slate-700">
                {po.supplier.name}
              </span>
            ) : (
              <span className="text-base text-amber-700">(no supplier)</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 flex-wrap">
            <span className="font-medium tabular-nums">
              {formatCurrency(po.totalCents, po.currencyCode)}
            </span>
            <span>
              {itemCount} {itemCount === 1 ? 'line' : 'lines'} · {totalUnits} units
            </span>
            <span title={new Date(po.createdAt).toLocaleString()}>
              · {relativeTime(po.createdAt)}
            </span>
            {po.warehouse?.code && <span>· {po.warehouse.code}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-4 space-y-4">
          {/* Action buttons */}
          {transitions.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {transitions.map((t) => {
                const requireReason = t.key === 'cancel'
                const Icon = t.icon
                if (showCancelConfirm && t.key === 'cancel') {
                  return null
                }
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => handleTransition(t.key, requireReason)}
                    disabled={transitioning !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-base font-medium rounded border transition-colors disabled:opacity-50',
                      t.variant === 'primary' &&
                        'bg-slate-900 text-white border-slate-900 hover:bg-slate-800',
                      t.variant === 'secondary' &&
                        'bg-white text-slate-700 border-slate-200 hover:bg-slate-50',
                      t.variant === 'danger' &&
                        'bg-white text-red-700 border-red-200 hover:bg-red-50',
                    )}
                  >
                    <Icon
                      className={cn(
                        'w-3.5 h-3.5',
                        transitioning === t.key && 'animate-spin',
                      )}
                    />
                    {transitioning === t.key ? 'Working…' : t.label}
                  </button>
                )
              })}
            </div>
          )}
          {showCancelConfirm && (
            <div className="bg-red-50 border border-red-200 rounded p-3 space-y-2">
              <div className="text-base text-red-900 font-medium">
                Cancel this PO?
              </div>
              <input
                type="text"
                placeholder="Reason (required)"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-2 py-1 text-base border border-red-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-red-300"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTransition('cancel', true)}
                  disabled={!cancelReason.trim() || transitioning !== null}
                  className="px-3 py-1 text-base font-medium text-white bg-red-600 border border-red-600 rounded hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCancelConfirm(false)
                    setCancelReason('')
                  }}
                  className="px-3 py-1 text-base font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50"
                >
                  Keep PO
                </button>
              </div>
            </div>
          )}

          {/* Line items */}
          <div className="bg-white border border-slate-200 rounded overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 text-sm font-semibold text-slate-700 uppercase tracking-wide">
              Line items
            </div>
            <table className="w-full text-base">
              <thead className="bg-slate-50 text-sm text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5">SKU</th>
                  <th className="text-right font-medium px-3 py-1.5">Ordered</th>
                  <th className="text-right font-medium px-3 py-1.5">Received</th>
                  <th className="text-right font-medium px-3 py-1.5">Unit cost</th>
                  <th className="text-right font-medium px-3 py-1.5">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {po.items.map((it) => (
                  <tr key={it.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-sm">{it.sku}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {it.quantityOrdered}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <span
                        className={cn(
                          it.quantityReceived === 0
                            ? 'text-slate-400'
                            : it.quantityReceived < it.quantityOrdered
                              ? 'text-amber-700'
                              : 'text-green-700',
                        )}
                      >
                        {it.quantityReceived}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatCurrency(it.unitCostCents, po.currencyCode)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                      {formatCurrency(
                        it.unitCostCents * it.quantityOrdered,
                        po.currencyCode,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Audit trail */}
          <div className="bg-white border border-slate-200 rounded p-3">
            <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
              Audit trail
            </div>
            <AuditTrailPanel poId={po.id} />
          </div>

          {/* Footer actions: PDF + email link */}
          <div className="flex items-center gap-2 text-sm">
            <a
              href={`${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
            >
              <FileText className="w-3 h-3" />
              Factory PDF
            </a>
            {po.supplier && po.supplierId && (
              <a
                href={`/products?supplierId=${po.supplierId}`}
                className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
              >
                <ShoppingCart className="w-3 h-3" />
                Supplier products
              </a>
            )}
            {po.notes && (
              <span className="text-slate-500 italic truncate flex-1">
                · {po.notes}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Top-level client ───────────────────────────────────────────────

export default function PurchaseOrdersClient() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlStatus = (searchParams.get('status') ?? 'all') as StatusFilter
  const validStatuses = useMemo(
    () => new Set(STATUS_FILTERS.map((f) => f.key as StatusFilter)),
    [],
  )
  const statusFilter: StatusFilter = validStatuses.has(urlStatus)
    ? urlStatus
    : 'all'
  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'all') params.delete('status')
      else params.set('status', next)
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    },
    [pathname, router, searchParams],
  )

  const [pos, setPos] = useState<PORow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchPos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/fulfillment/purchase-orders`,
      )
      if (statusFilter !== 'all' && statusFilter !== 'active') {
        url.searchParams.set('status', statusFilter)
      } else if (statusFilter === 'active') {
        url.searchParams.set('status', Array.from(ACTIVE_STATUSES).join(','))
      }
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setPos(data.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    fetchPos()
  }, [fetchPos])

  const counts = useMemo(() => {
    const c: Record<string, number> = { active: 0 }
    if (pos) {
      for (const p of pos) {
        c[p.status] = (c[p.status] ?? 0) + 1
        if (ACTIVE_STATUSES.has(p.status)) c.active++
      }
    }
    return c
  }, [pos])

  const handleTransition = useCallback(
    async (poId: string, transition: string, reason?: string) => {
      setActionError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/transition`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition, reason }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        await fetchPos()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [fetchPos],
  )

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => {
            const count = f.key === 'all' ? pos?.length ?? 0 : counts[f.key] ?? 0
            return (
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
                {pos && count > 0 && (
                  <span className="ml-1 opacity-70">{count}</span>
                )}
              </button>
            )
          })}
        </div>
        <Button variant="secondary" size="sm" onClick={fetchPos} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Error toasts */}
      {error && (
        <div className="text-md text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Failed to load: {error}
        </div>
      )}
      {actionError && (
        <div className="text-md text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {actionError}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !pos && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 bg-white border border-slate-200 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {pos && pos.length === 0 && !loading && (
        <EmptyState
          icon={ShoppingCart}
          title={
            statusFilter === 'all'
              ? 'No purchase orders yet'
              : 'No POs in this state'
          }
          description={
            statusFilter === 'all'
              ? 'Run a bulk-PO from /fulfillment/replenishment or create one manually to populate this view.'
              : 'Try a different filter or wait for POs to land in this state.'
          }
          action={
            statusFilter === 'all'
              ? { label: 'Open Replenishment', href: '/fulfillment/replenishment' }
              : undefined
          }
        />
      )}

      {/* PO list */}
      {pos && pos.length > 0 && (
        <div className="space-y-2">
          {pos.map((po) => (
            <PoCard key={po.id} po={po} onTransition={handleTransition} />
          ))}
        </div>
      )}
    </div>
  )
}
