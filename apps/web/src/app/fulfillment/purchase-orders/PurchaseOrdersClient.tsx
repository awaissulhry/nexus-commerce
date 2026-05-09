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
  Plus,
  RefreshCw,
  Search,
  Send,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
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

// labelKey → t() lookup at render. Keeps the mapping table flat
// while still locale-aware.
const STATUS_FILTERS: Array<{ key: StatusFilter; labelKey: string }> = [
  { key: 'all', labelKey: 'po.filter.all' },
  { key: 'active', labelKey: 'po.filter.active' },
  { key: 'DRAFT', labelKey: 'po.status.DRAFT' },
  { key: 'REVIEW', labelKey: 'po.status.REVIEW' },
  { key: 'APPROVED', labelKey: 'po.status.APPROVED' },
  { key: 'SUBMITTED', labelKey: 'po.status.SUBMITTED' },
  { key: 'ACKNOWLEDGED', labelKey: 'po.status.ACKNOWLEDGED' },
  { key: 'RECEIVED', labelKey: 'po.status.RECEIVED' },
  { key: 'CANCELLED', labelKey: 'po.status.CANCELLED' },
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
      return <FileText className={cn(cls, 'text-slate-500 dark:text-slate-400')} />
    case 'REVIEW':
      return <Clock className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
    case 'APPROVED':
      return <FileCheck2 className={cn(cls, 'text-blue-600 dark:text-blue-400')} />
    case 'SUBMITTED':
      return <Send className={cn(cls, 'text-blue-600 dark:text-blue-400')} />
    case 'ACKNOWLEDGED':
    case 'CONFIRMED':
      return <CheckCircle2 className={cn(cls, 'text-green-600 dark:text-green-400')} />
    case 'PARTIAL':
      return <PackageCheck className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
    case 'RECEIVED':
      return <PackageCheck className={cn(cls, 'text-green-600 dark:text-green-400')} />
    case 'CANCELLED':
      return <Ban className={cn(cls, 'text-red-600 dark:text-red-400')} />
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
  labelKey: string
  variant: 'primary' | 'secondary' | 'danger'
  icon: typeof Send
  destructive?: boolean
}> {
  switch (status) {
    case 'DRAFT':
      return [
        { key: 'submit-for-review', labelKey: 'po.transition.submitForReview', variant: 'primary', icon: ChevronRight },
        { key: 'cancel', labelKey: 'po.transition.cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'REVIEW':
      return [
        { key: 'approve', labelKey: 'po.transition.approve', variant: 'primary', icon: FileCheck2 },
        { key: 'cancel', labelKey: 'po.transition.cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'APPROVED':
      return [
        { key: 'send', labelKey: 'po.transition.send', variant: 'primary', icon: Send },
        { key: 'cancel', labelKey: 'po.transition.cancel', variant: 'danger', icon: Ban, destructive: true },
      ]
    case 'SUBMITTED':
      return [
        { key: 'acknowledge', labelKey: 'po.transition.acknowledge', variant: 'primary', icon: CheckCircle2 },
      ]
    default:
      return []
  }
}

// ── Audit trail panel ──────────────────────────────────────────────

function AuditTrailPanel({ poId }: { poId: string }) {
  const { t } = useTranslations()
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
      <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('po.audit.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="text-base text-red-700 dark:text-red-300">{t('po.audit.unavailable', { error })}</div>
    )
  }
  if (!trail || trail.length === 0) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400">{t('po.audit.empty')}</div>
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
          <span className="text-slate-500 dark:text-slate-400" title={new Date(entry.at).toLocaleString()}>
            {relativeTime(entry.at)}
          </span>
          {entry.byUserId && (
            <span className="text-slate-500 dark:text-slate-400">· {entry.byUserId}</span>
          )}
          {entry.reason && (
            <span className="text-slate-500 dark:text-slate-400">· {entry.reason}</span>
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
  const { t } = useTranslations()
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
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-3 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          )}
        </div>
        <StatusIcon status={po.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-mono font-medium text-slate-900 dark:text-slate-100 text-md">
              {po.poNumber}
            </h3>
            <Badge variant={statusVariant(po.status)} size="sm">
              {po.status.replace(/_/g, ' ')}
            </Badge>
            {po.supplier ? (
              <span className="text-base text-slate-700 dark:text-slate-300">
                {po.supplier.name}
              </span>
            ) : (
              <span className="text-base text-amber-700 dark:text-amber-300">{t('po.noSupplier')}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 dark:text-slate-400 flex-wrap">
            <span className="font-medium tabular-nums">
              {formatCurrency(po.totalCents, po.currencyCode)}
            </span>
            <span>
              {t(itemCount === 1 ? 'po.summary.line' : 'po.summary.lines', { count: itemCount, units: totalUnits })}
            </span>
            <span title={new Date(po.createdAt).toLocaleString()}>
              · {relativeTime(po.createdAt)}
            </span>
            {po.warehouse?.code && <span>· {po.warehouse.code}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-5 py-4 space-y-4">
          {/* Action buttons */}
          {transitions.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {transitions.map((tr) => {
                const requireReason = tr.key === 'cancel'
                const Icon = tr.icon
                if (showCancelConfirm && tr.key === 'cancel') {
                  return null
                }
                return (
                  <button
                    key={tr.key}
                    type="button"
                    onClick={() => handleTransition(tr.key, requireReason)}
                    disabled={transitioning !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-base font-medium rounded border transition-colors disabled:opacity-50',
                      tr.variant === 'primary' &&
                        'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 hover:bg-slate-800',
                      tr.variant === 'secondary' &&
                        'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                      tr.variant === 'danger' &&
                        'bg-white dark:bg-slate-900 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40',
                    )}
                  >
                    <Icon
                      className={cn(
                        'w-3.5 h-3.5',
                        transitioning === tr.key && 'animate-spin',
                      )}
                    />
                    {transitioning === tr.key ? t('po.working') : t(tr.labelKey as any)}
                  </button>
                )
              })}
            </div>
          )}
          {showCancelConfirm && (
            <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 space-y-2">
              <div className="text-base text-red-900 dark:text-red-100 font-medium">
                {t('po.cancel.title')}
              </div>
              <input
                type="text"
                placeholder={t('po.cancel.reasonPlaceholder')}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-2 py-1 text-base border border-red-200 dark:border-red-900 rounded bg-white dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-red-300"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTransition('cancel', true)}
                  disabled={!cancelReason.trim() || transitioning !== null}
                  className="px-3 py-1 text-base font-medium text-white bg-red-600 dark:bg-red-700 border border-red-600 dark:border-red-500 rounded hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
                >
                  {t('po.cancel.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCancelConfirm(false)
                    setCancelReason('')
                  }}
                  className="px-3 py-1 text-base font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {t('po.cancel.keep')}
                </button>
              </div>
            </div>
          )}

          {/* Line items */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              {t('po.lineItems')}
            </div>
            <table className="w-full text-base">
              <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5">{t('po.col.sku')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.ordered')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.received')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.unitCost')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.subtotal')}</th>
                </tr>
              </thead>
              <tbody>
                {po.items.map((it) => (
                  <tr key={it.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-sm">{it.sku}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {it.quantityOrdered}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <span
                        className={cn(
                          it.quantityReceived === 0
                            ? 'text-slate-400 dark:text-slate-500'
                            : it.quantityReceived < it.quantityOrdered
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-green-700 dark:text-green-300',
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
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-2">
              {t('po.auditTrail')}
            </div>
            <AuditTrailPanel poId={po.id} />
          </div>

          {/* Footer actions: PDF + email link */}
          <div className="flex items-center gap-2 text-sm">
            <a
              href={`${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <FileText className="w-3 h-3" />
              {t('po.factoryPdf')}
            </a>
            {po.supplier && po.supplierId && (
              <a
                href={`/products?supplierId=${po.supplierId}`}
                className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <ShoppingCart className="w-3 h-3" />
                {t('po.supplierProducts')}
              </a>
            )}
            {po.notes && (
              <span className="text-slate-500 dark:text-slate-400 italic truncate flex-1">
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
  const { t } = useTranslations()
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
  // F2.8 — search across poNumber + supplier name + line SKU. Local
  // filter (no server round-trip) since lists are small (<200 active).
  const [search, setSearch] = useState('')
  // F2.8 — Create PO modal toggle.
  const [createOpen, setCreateOpen] = useState(false)

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

  // F2.8 — local search filter. Match poNumber, supplier name, or
  // any line-item SKU (case-insensitive substring).
  const filteredPos = useMemo(() => {
    if (!pos) return null
    const q = search.trim().toLowerCase()
    if (!q) return pos
    return pos.filter((p) => {
      if (p.poNumber.toLowerCase().includes(q)) return true
      if (p.supplier?.name?.toLowerCase().includes(q)) return true
      if (p.items.some((it) => it.sku.toLowerCase().includes(q))) return true
      return false
    })
  }, [pos, search])

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
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {t(f.labelKey as any)}
                {pos && count > 0 && (
                  <span className="ml-1 opacity-70">{count}</span>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* F2.8 — local search across poNumber + supplier + SKU. */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('po.search.placeholder')}
              className="h-8 pl-7 pr-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 w-56"
            />
          </div>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            {t('po.newPo')}
          </Button>
          <Button variant="secondary" size="sm" onClick={fetchPos} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* Error toasts */}
      {error && (
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {t('po.failedToLoad', { error })}
        </div>
      )}
      {actionError && (
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
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
              className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse"
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
              ? t('po.empty.title')
              : t('po.empty.titleFiltered')
          }
          description={
            statusFilter === 'all'
              ? t('po.empty.description')
              : t('po.empty.descriptionFiltered')
          }
          action={
            statusFilter === 'all'
              ? { label: t('po.empty.openReplenishment'), href: '/fulfillment/replenishment' }
              : undefined
          }
        />
      )}

      {/* F2.8 — search-empty state when filter eliminates all rows
          but the underlying list isn't empty. */}
      {pos && pos.length > 0 && filteredPos && filteredPos.length === 0 && (
        <div className="text-md text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-6 text-center">
          {t('po.search.noMatches', { q: search })}
        </div>
      )}

      {/* PO list */}
      {filteredPos && filteredPos.length > 0 && (
        <div className="space-y-2">
          {filteredPos.map((po) => (
            <PoCard key={po.id} po={po} onTransition={handleTransition} />
          ))}
        </div>
      )}

      {/* F2.8 — Create PO modal. Renders only when open; mounts the
          form inline so each open is a fresh state. */}
      {createOpen && (
        <CreatePoModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false)
            await fetchPos()
          }}
        />
      )}
    </div>
  )
}

// ── Create PO modal ────────────────────────────────────────────────
//
// Minimal manual-create flow. Most POs land here via replenishment
// auto-create; this is the escape hatch for the operator who wants
// to draft a PO themselves (one-off supplier order, partial top-up,
// emergency restock).
//
// Required fields per the API: items[] (≥1 row with SKU + qty).
// supplier + warehouse are optional at the schema layer (warehouse
// defaults server-side); we still surface them so the operator
// makes the explicit choice when it matters.

interface SupplierOption {
  id: string
  name: string
  isActive: boolean
}

interface DraftLine {
  // local-only id for keying
  uid: string
  sku: string
  quantityOrdered: string
  unitCostCents: string
}

let lineSeq = 0
const newLine = (): DraftLine => ({
  uid: `l${++lineSeq}`,
  sku: '',
  quantityOrdered: '',
  unitCostCents: '',
})

function CreatePoModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void | Promise<void>
}) {
  const { t } = useTranslations()
  const [suppliers, setSuppliers] = useState<SupplierOption[] | null>(null)
  const [supplierId, setSupplierId] = useState<string>('')
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([newLine()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/fulfillment/suppliers?activeOnly=true`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data) => {
        if (!cancelled) setSuppliers(data.items ?? [])
      })
      .catch(() => { if (!cancelled) setSuppliers([]) })
    return () => { cancelled = true }
  }, [])

  // Esc closes the modal — mirrors routing-rules + qc-queue patterns.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [submitting, onClose])

  const updateLine = (uid: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)))
  }
  const removeLine = (uid: string) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.uid !== uid)))
  }

  const totalCents = lines.reduce((s, l) => {
    const qty = parseInt(l.quantityOrdered, 10) || 0
    const cost = Math.round(parseFloat(l.unitCostCents || '0') * 100) || 0
    return s + qty * cost
  }, 0)

  const submit = async () => {
    setError(null)
    const validLines = lines.filter((l) => l.sku.trim() && parseInt(l.quantityOrdered, 10) > 0)
    if (validLines.length === 0) {
      setError(t('po.create.error.noLines'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/purchase-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: supplierId || undefined,
          expectedDeliveryDate: expectedDate || undefined,
          notes: notes.trim() || undefined,
          items: validLines.map((l) => ({
            sku: l.sku.trim(),
            quantityOrdered: parseInt(l.quantityOrdered, 10),
            unitCostCents: Math.round(parseFloat(l.unitCostCents || '0') * 100) || 0,
          })),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-po-title"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-900">
          <h2 id="create-po-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('po.create.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label={t('po.create.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                {t('po.create.supplier')}
              </label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                disabled={submitting}
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="">{t('po.create.supplierNone')}</option>
                {suppliers?.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                {t('po.create.expectedDate')}
              </label>
              <input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                disabled={submitting}
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('po.create.lines')}
              </label>
              <button
                type="button"
                onClick={() => setLines((prev) => [...prev, newLine()])}
                disabled={submitting}
                className="text-sm px-2 py-1 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
              >
                <Plus size={11} /> {t('po.create.addLine')}
              </button>
            </div>
            <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
              <table className="w-full text-base">
                <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">{t('po.col.sku')}</th>
                    <th className="text-right font-medium px-3 py-1.5 w-24">{t('po.col.ordered')}</th>
                    <th className="text-right font-medium px-3 py-1.5 w-28">{t('po.col.unitCost')}</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.uid} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={l.sku}
                          onChange={(e) => updateLine(l.uid, { sku: e.target.value })}
                          placeholder="SKU"
                          disabled={submitting}
                          className="w-full h-8 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="1"
                          value={l.quantityOrdered}
                          onChange={(e) => updateLine(l.uid, { quantityOrdered: e.target.value })}
                          disabled={submitting}
                          className="w-full h-8 px-2 text-base text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={l.unitCostCents}
                          onChange={(e) => updateLine(l.uid, { unitCostCents: e.target.value })}
                          disabled={submitting}
                          placeholder="0.00"
                          className="w-full h-8 px-2 text-base text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => removeLine(l.uid)}
                          disabled={submitting || lines.length === 1}
                          className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-30"
                          aria-label={t('po.create.removeLine')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 text-right tabular-nums">
              {t('po.create.total')}: <span className="font-semibold text-slate-900 dark:text-slate-100">€{(totalCents / 100).toFixed(2)}</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
              {t('po.create.notes')}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder={t('po.create.notesPlaceholder')}
              className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
          </div>

          {error && (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700 sticky bottom-0 bg-white dark:bg-slate-900">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('po.create.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
            {submitting ? t('po.create.creating') : t('po.create.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
