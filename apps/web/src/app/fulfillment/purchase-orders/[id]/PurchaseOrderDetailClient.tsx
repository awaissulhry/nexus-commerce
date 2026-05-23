'use client'

// PO.2 — Purchase-order detail page client.
//
// Sections:
//   - Header (back, PO #, status badge, total, action cluster)
//   - Identity strip (supplier, warehouse, expected ETA, supplier-confirmed ETA, created)
//   - Tabs: Summary | Activity | Shipments | Attachments | Revisions | Comments
//   - Print mode: `@media print` hides chrome + tabs and renders all tab
//     contents as a single document — gives operators a printable cover
//     sheet alongside the factory PDF.
//
// Helpers (statusVariant, StatusIcon, availableTransitions, relativeTime,
// formatCurrency) duplicate the list page for now. PO.3 hoists them
// to a shared `_shared/po-lens` module alongside the grid components.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Printer,
  ShoppingCart,
  Truck,
  Paperclip,
  GitBranch,
  Activity as ActivityIcon,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useInboundEvents } from '@/lib/sync/use-inbound-events'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import {
  StatusIcon,
  availableTransitions,
  formatCurrency,
  relativeTime,
  statusVariant,
} from '../_shared/po-lens'

// ── Types ──────────────────────────────────────────────────────────

interface POItem {
  id: string
  productId: string | null
  sku: string
  supplierSku: string | null
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
  note: string | null
  lineOrder: number
}

interface POAttachment {
  id: string
  kind: string
  url: string
  filename: string | null
  contentType: string | null
  sizeBytes: number | null
  uploadedBy: string | null
  uploadedAt: string
}

interface PORevision {
  id: string
  version: number
  reason: string | null
  status: string
  createdAt: string
  createdBy: string | null
  supplierNotifiedAt: string | null
  supplierAckedAt: string | null
  cancelledAt: string | null
}

interface POComment {
  id: string
  userId: string | null
  body: string
  mentions: string[]
  createdAt: string
}

interface POInboundShipment {
  id: string
  status: string
  reference: string | null
  expectedAt: string | null
  arrivedAt: string | null
  carrierCode: string | null
  trackingNumber: string | null
}

interface PODetail {
  id: string
  poNumber: string
  supplierId: string | null
  supplier: { id: string; name: string; email: string | null } | null
  warehouseId: string | null
  warehouse: { code: string; name: string | null } | null
  status: string
  totalCents: number
  currencyCode: string
  notes: string | null
  expectedDeliveryDate: string | null
  supplierConfirmedDeliveryDate: string | null
  supplierConfirmedAt: string | null
  reviewedAt: string | null
  approvedAt: string | null
  submittedAt: string | null
  acknowledgedAt: string | null
  cancelledAt: string | null
  cancelledReason: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  version: number
  deletedAt: string | null
  items: POItem[]
  inboundShipments: POInboundShipment[]
  attachments: POAttachment[]
  revisions: PORevision[]
  comments: POComment[]
}

interface AuditEntry {
  status: string
  at: string
  byUserId: string | null
  reason?: string | null
}

type Tab = 'summary' | 'activity' | 'shipments' | 'attachments' | 'revisions' | 'comments'

// ── Helpers (small, detail-page-local) ──────────────────────────────

function formatBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ── Tab nav ────────────────────────────────────────────────────────

const TAB_ORDER: Array<{ key: Tab; label: string; icon: typeof FileText }> = [
  { key: 'summary', label: 'Summary', icon: FileText },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
  { key: 'shipments', label: 'Shipments', icon: Truck },
  { key: 'attachments', label: 'Attachments', icon: Paperclip },
  { key: 'revisions', label: 'Revisions', icon: GitBranch },
  { key: 'comments', label: 'Comments', icon: MessageSquare },
]

// ── Print-mode CSS ─────────────────────────────────────────────────
//
// Hides chrome (back link, tabs, action cluster, page-level toolbar)
// and forces every tab body to render inline so an operator can
// File → Print → save as PDF and get a single readable document.
const PRINT_CSS = `
  @media print {
    .po-detail-no-print { display: none !important; }
    .po-detail-print-all > section { break-inside: avoid; margin-bottom: 1.5rem; }
    .po-detail-print-all > section[data-tab-pane] { display: block !important; }
  }
`

// ── Main client ────────────────────────────────────────────────────

export default function PurchaseOrderDetailClient({ id }: { id: string }) {
  const { t } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlTab = (searchParams.get('tab') as Tab) || 'summary'
  const tab: Tab = TAB_ORDER.some((x) => x.key === urlTab) ? urlTab : 'summary'
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'summary') params.delete('tab')
      else params.set('tab', next)
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const [po, setPo] = useState<PODetail | null>(null)
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/purchase-orders/${id}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/fulfillment/purchase-orders/${id}/audit`, { cache: 'no-store' }),
      ])
      if (!pRes.ok) {
        const body = await pRes.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${pRes.status}`)
      }
      const data = await pRes.json()
      setPo(data)
      if (aRes.ok) {
        const aData = await aRes.json()
        setAudit(aData.trail ?? [])
      } else {
        setAudit([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    refresh()
  }, [refresh])

  // F-RT.1 — inbound SSE pipe so a receive against this PO auto-
  // refreshes status + quantityReceived rollup. PO.4 will swap to
  // proper po.* events but inbound.* gives us the practical hot path.
  useInboundEvents()
  useInvalidationChannel(
    ['inbound.received', 'inbound.updated', 'inbound.discrepancy', 'inbound.created'],
    useCallback(() => {
      refresh()
    }, [refresh]),
  )

  const handleTransition = useCallback(
    async (transition: string, reason?: string) => {
      setActionError(null)
      setTransitioning(transition)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${id}/transition`,
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
        await refresh()
        setShowCancelConfirm(false)
        setCancelReason('')
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setTransitioning(null)
      }
    },
    [id, refresh],
  )

  const totalUnits = useMemo(
    () => po?.items.reduce((s, i) => s + i.quantityOrdered, 0) ?? 0,
    [po],
  )
  const totalReceived = useMemo(
    () => po?.items.reduce((s, i) => s + i.quantityReceived, 0) ?? 0,
    [po],
  )
  const receivePct = totalUnits > 0 ? Math.round((totalReceived / totalUnits) * 100) : 0

  // ── Render ───────────────────────────────────────────────────────

  if (loading && !po) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error || !po) {
    return (
      <div className="space-y-3">
        <PageHeader
          title="Purchase order"
          breadcrumbs={[
            { label: 'Fulfillment', href: '/fulfillment' },
            { label: 'Purchase orders', href: '/fulfillment/purchase-orders' },
            { label: id },
          ]}
        />
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error ?? t('po.detail.notFound')}
        </div>
      </div>
    )
  }

  const transitions = availableTransitions(po.status)

  return (
    <div className="space-y-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* Chrome — hidden in print */}
      <div className="po-detail-no-print">
        <PageHeader
          title={po.poNumber}
          breadcrumbs={[
            { label: 'Fulfillment', href: '/fulfillment' },
            { label: 'Purchase orders', href: '/fulfillment/purchase-orders' },
            { label: po.poNumber },
          ]}
          actions={
            <div className="flex items-center gap-2">
              <Link
                href="/fulfillment/purchase-orders"
                className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </Link>
              <button
                type="button"
                onClick={() => window.print()}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                title="Print or save as PDF"
              >
                <Printer className="w-3.5 h-3.5" />
                Print
              </button>
              <a
                href={`${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 px-3 inline-flex items-center gap-1.5 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <FileText className="w-3.5 h-3.5" />
                Factory PDF
              </a>
            </div>
          }
        />
      </div>

      {/* Identity strip + status banner */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <StatusIcon status={po.status} className="w-5 h-5" />
            <Badge variant={statusVariant(po.status)} size="md">
              {po.status.replace(/_/g, ' ')}
            </Badge>
            {po.deletedAt && (
              <Badge variant="danger" size="md">
                In recycle bin
              </Badge>
            )}
            <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {formatCurrency(po.totalCents, po.currencyCode)}
            </span>
            <span className="text-base text-slate-500 dark:text-slate-400">
              · {po.items.length} {po.items.length === 1 ? 'line' : 'lines'} · {totalUnits} units
            </span>
          </div>

          {/* Action cluster — primary transitions inline (visibility over minimalism). */}
          <div className="flex items-center gap-2 flex-wrap po-detail-no-print">
            {transitions.map((tr) => {
              const Icon = tr.icon
              if (tr.key === 'cancel' && showCancelConfirm) return null
              const requireReason = tr.key === 'cancel'
              return (
                <button
                  key={tr.key}
                  type="button"
                  onClick={() =>
                    requireReason ? setShowCancelConfirm(true) : handleTransition(tr.key)
                  }
                  disabled={transitioning !== null}
                  className={cn(
                    'h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border transition-colors disabled:opacity-50',
                    tr.variant === 'primary' &&
                      'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100 hover:bg-slate-800 dark:hover:bg-slate-200',
                    tr.variant === 'secondary' &&
                      'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                    tr.variant === 'danger' &&
                      'bg-white dark:bg-slate-900 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40',
                  )}
                >
                  {transitioning === tr.key ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                  {t(tr.labelKey as any)}
                </button>
              )
            })}
          </div>
        </div>

        {showCancelConfirm && (
          <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 space-y-2 po-detail-no-print">
            <div className="text-base text-red-900 dark:text-red-100 font-medium">
              Cancel this purchase order?
            </div>
            <input
              type="text"
              placeholder="Reason (required)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="w-full px-2 py-1 text-base border border-red-200 dark:border-red-900 rounded bg-white dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-red-300"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleTransition('cancel', cancelReason.trim())}
                disabled={!cancelReason.trim() || transitioning !== null}
                className="px-3 py-1 text-base font-medium text-white bg-red-600 dark:bg-red-700 border border-red-600 dark:border-red-500 rounded hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
              >
                Yes, cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCancelConfirm(false)
                  setCancelReason('')
                }}
                className="px-3 py-1 text-base font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Keep
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2 po-detail-no-print">
            <AlertCircle className="w-4 h-4" />
            {actionError}
          </div>
        )}

        {/* Identity grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
          <DetailField label="Supplier">
            {po.supplier ? (
              <Link
                href={`/products?supplierId=${po.supplierId}`}
                className="text-slate-900 dark:text-slate-100 hover:underline inline-flex items-center gap-1"
              >
                <ShoppingCart className="w-3 h-3" /> {po.supplier.name}
              </Link>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">No supplier</span>
            )}
            {po.supplier?.email && (
              <a
                href={`mailto:${po.supplier.email}`}
                className="block text-sm text-slate-500 dark:text-slate-400 hover:underline mt-0.5 inline-flex items-center gap-1"
              >
                <Mail className="w-3 h-3" /> {po.supplier.email}
              </a>
            )}
          </DetailField>
          <DetailField label="Warehouse">
            {po.warehouse?.code ? (
              <span className="text-slate-900 dark:text-slate-100">
                {po.warehouse.code}
                {po.warehouse.name ? ` · ${po.warehouse.name}` : ''}
              </span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">—</span>
            )}
          </DetailField>
          <DetailField label="Expected delivery">
            {po.expectedDeliveryDate ? (
              <span className="text-slate-900 dark:text-slate-100">
                {new Date(po.expectedDeliveryDate).toISOString().slice(0, 10)}
              </span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">—</span>
            )}
          </DetailField>
          <DetailField label="Supplier-confirmed ETA">
            {po.supplierConfirmedDeliveryDate ? (
              <span className="text-green-700 dark:text-green-300 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {new Date(po.supplierConfirmedDeliveryDate).toISOString().slice(0, 10)}
              </span>
            ) : po.status === 'SUBMITTED' || po.status === 'APPROVED' ? (
              <span className="text-amber-700 dark:text-amber-300">Awaiting supplier</span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">—</span>
            )}
          </DetailField>
          <DetailField label="Created">
            <span title={new Date(po.createdAt).toLocaleString()}>
              {relativeTime(po.createdAt)}
            </span>
            {po.createdBy && (
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                by {po.createdBy}
              </span>
            )}
          </DetailField>
          <DetailField label="Last updated">
            <span title={new Date(po.updatedAt).toLocaleString()}>
              {relativeTime(po.updatedAt)}
            </span>
          </DetailField>
          <DetailField label="Receive progress">
            {totalUnits > 0 ? (
              <div>
                <span className="tabular-nums text-slate-900 dark:text-slate-100">
                  {totalReceived} / {totalUnits}
                </span>
                <div className="mt-1 h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      receivePct === 100
                        ? 'bg-green-500'
                        : receivePct > 0
                          ? 'bg-amber-500'
                          : 'bg-slate-300 dark:bg-slate-700',
                    )}
                    style={{ width: `${receivePct}%` }}
                  />
                </div>
              </div>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">—</span>
            )}
          </DetailField>
          <DetailField label="Currency">
            <span className="font-mono text-slate-900 dark:text-slate-100">
              {po.currencyCode}
            </span>
          </DetailField>
        </div>
      </div>

      {/* Tab nav — hidden in print, all panes render in print */}
      <div className="po-detail-no-print flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
        {TAB_ORDER.map((x) => {
          const Icon = x.icon
          const active = tab === x.key
          const count =
            x.key === 'attachments'
              ? po.attachments.length
              : x.key === 'revisions'
                ? po.revisions.length
                : x.key === 'comments'
                  ? po.comments.length
                  : x.key === 'shipments'
                    ? po.inboundShipments.length
                    : null
          return (
            <button
              key={x.key}
              type="button"
              onClick={() => setTab(x.key)}
              className={cn(
                'h-9 px-3 inline-flex items-center gap-1.5 text-base font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {x.label}
              {count != null && count > 0 && (
                <span className="text-sm text-slate-500 dark:text-slate-400">{count}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content. Each pane is a <section data-tab-pane>; print
          mode forces every section to display so the printable view
          is a single document. */}
      <div className="po-detail-print-all space-y-4">
        <section data-tab-pane className={cn(tab !== 'summary' && 'po-detail-no-print')}>
          <SummaryPane po={po} />
        </section>
        <section data-tab-pane className={cn(tab !== 'activity' && 'po-detail-no-print')}>
          <ActivityPane audit={audit} />
        </section>
        <section data-tab-pane className={cn(tab !== 'shipments' && 'po-detail-no-print')}>
          <ShipmentsPane shipments={po.inboundShipments} />
        </section>
        <section data-tab-pane className={cn(tab !== 'attachments' && 'po-detail-no-print')}>
          <AttachmentsPane attachments={po.attachments} />
        </section>
        <section data-tab-pane className={cn(tab !== 'revisions' && 'po-detail-no-print')}>
          <RevisionsPane revisions={po.revisions} />
        </section>
        <section data-tab-pane className={cn(tab !== 'comments' && 'po-detail-no-print')}>
          <CommentsPane comments={po.comments} />
        </section>
      </div>
    </div>
  )
}

// ── Subcomponents ──────────────────────────────────────────────────

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-base">{children}</div>
    </div>
  )
}

function SummaryPane({ po }: { po: PODetail }) {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center justify-between">
          <span>Line items</span>
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            {po.items.length} {po.items.length === 1 ? 'line' : 'lines'}
          </span>
        </div>
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th className="text-left font-medium px-4 py-1.5 w-10">#</th>
              <th className="text-left font-medium px-4 py-1.5">SKU</th>
              <th className="text-left font-medium px-4 py-1.5">Supplier SKU</th>
              <th className="text-right font-medium px-4 py-1.5">Ordered</th>
              <th className="text-right font-medium px-4 py-1.5">Received</th>
              <th className="text-right font-medium px-4 py-1.5">Unit cost</th>
              <th className="text-right font-medium px-4 py-1.5">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {po.items.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400"
                >
                  No lines on this PO.
                </td>
              </tr>
            )}
            {po.items.map((it, idx) => (
              <tr
                key={it.id}
                className="border-b border-slate-100 dark:border-slate-800 last:border-0"
              >
                <td className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                  {idx + 1}
                </td>
                <td className="px-4 py-2 font-mono text-sm">
                  {it.productId ? (
                    <Link
                      href={`/products/${it.productId}/edit`}
                      className="text-slate-900 dark:text-slate-100 hover:underline"
                    >
                      {it.sku}
                    </Link>
                  ) : (
                    it.sku
                  )}
                  {it.note && (
                    <div className="text-sm text-slate-500 dark:text-slate-400 italic mt-0.5 font-sans">
                      {it.note}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-sm text-slate-500 dark:text-slate-400">
                  {it.supplierSku ?? '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{it.quantityOrdered}</td>
                <td className="px-4 py-2 text-right tabular-nums">
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
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatCurrency(it.unitCostCents, po.currencyCode)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">
                  {formatCurrency(it.unitCostCents * it.quantityOrdered, po.currencyCode)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700">
            <tr>
              <td colSpan={6} className="px-4 py-2 text-right text-sm font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                Total
              </td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                {formatCurrency(po.totalCents, po.currencyCode)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {po.notes && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-2">
            Notes
          </div>
          <div className="text-base text-slate-900 dark:text-slate-100 whitespace-pre-wrap">
            {po.notes}
          </div>
        </div>
      )}

      {po.cancelledReason && po.status === 'CANCELLED' && (
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg p-4">
          <div className="text-sm font-semibold text-red-900 dark:text-red-100 uppercase tracking-wide mb-1">
            Cancelled
          </div>
          <div className="text-base text-red-800 dark:text-red-200">{po.cancelledReason}</div>
        </div>
      )}
    </div>
  )
}

function ActivityPane({ audit }: { audit: AuditEntry[] | null }) {
  if (!audit) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading audit trail…
      </div>
    )
  }
  if (audit.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-6">
        <div className="text-base text-slate-500 dark:text-slate-400">
          No activity yet.
        </div>
      </div>
    )
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-2">
      {audit.map((e, idx) => (
        <div
          key={`${e.status}-${e.at}-${idx}`}
          className="flex items-center gap-3 text-base"
        >
          <StatusIcon status={e.status} />
          <Badge variant={statusVariant(e.status)} size="sm">
            {e.status.replace(/_/g, ' ')}
          </Badge>
          <span className="text-slate-500 dark:text-slate-400" title={new Date(e.at).toLocaleString()}>
            {relativeTime(e.at)}
          </span>
          {e.byUserId && (
            <span className="text-slate-500 dark:text-slate-400">· {e.byUserId}</span>
          )}
          {e.reason && (
            <span className="text-slate-500 dark:text-slate-400">· {e.reason}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function ShipmentsPane({ shipments }: { shipments: POInboundShipment[] }) {
  if (shipments.length === 0) {
    return (
      <EmptyState
        icon={Truck}
        title="No linked shipments"
        description="When this PO is received, an inbound shipment will appear here."
      />
    )
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <table className="w-full text-base">
        <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
          <tr>
            <th className="text-left font-medium px-4 py-1.5">Shipment</th>
            <th className="text-left font-medium px-4 py-1.5">Status</th>
            <th className="text-left font-medium px-4 py-1.5">Carrier</th>
            <th className="text-left font-medium px-4 py-1.5">Expected</th>
            <th className="text-left font-medium px-4 py-1.5">Arrived</th>
          </tr>
        </thead>
        <tbody>
          {shipments.map((s) => (
            <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
              <td className="px-4 py-2">
                <Link
                  href={`/fulfillment/inbound?shipmentId=${s.id}`}
                  className="font-mono text-sm text-slate-900 dark:text-slate-100 hover:underline"
                >
                  {s.reference ?? s.id.slice(0, 10)}
                </Link>
              </td>
              <td className="px-4 py-2">
                <Badge variant={statusVariant(s.status)} size="sm">
                  {s.status.replace(/_/g, ' ')}
                </Badge>
              </td>
              <td className="px-4 py-2">
                {s.carrierCode ? (
                  <span className="font-mono text-sm">
                    {s.carrierCode}
                    {s.trackingNumber ? ` · ${s.trackingNumber}` : ''}
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">—</span>
                )}
              </td>
              <td className="px-4 py-2 tabular-nums">
                {s.expectedAt ? new Date(s.expectedAt).toISOString().slice(0, 10) : '—'}
              </td>
              <td className="px-4 py-2 tabular-nums">
                {s.arrivedAt ? (
                  <span className="text-green-700 dark:text-green-300">
                    {new Date(s.arrivedAt).toISOString().slice(0, 10)}
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AttachmentsPane({ attachments }: { attachments: POAttachment[] }) {
  if (attachments.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title="No attachments"
        description="Supplier quotes, contracts, art files, and label sheets will appear here. Upload UI ships in PO.5."
      />
    )
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <table className="w-full text-base">
        <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
          <tr>
            <th className="text-left font-medium px-4 py-1.5">File</th>
            <th className="text-left font-medium px-4 py-1.5">Kind</th>
            <th className="text-left font-medium px-4 py-1.5">Size</th>
            <th className="text-left font-medium px-4 py-1.5">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {attachments.map((a) => (
            <tr key={a.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
              <td className="px-4 py-2">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-900 dark:text-slate-100 hover:underline inline-flex items-center gap-1.5"
                >
                  <Paperclip className="w-3 h-3" />
                  {a.filename ?? a.url}
                </a>
              </td>
              <td className="px-4 py-2">
                <Badge variant="default" size="sm">
                  {a.kind}
                </Badge>
              </td>
              <td className="px-4 py-2 tabular-nums text-sm text-slate-500 dark:text-slate-400">
                {formatBytes(a.sizeBytes)}
              </td>
              <td className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">
                {relativeTime(a.uploadedAt)}
                {a.uploadedBy ? ` · ${a.uploadedBy}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RevisionsPane({ revisions }: { revisions: PORevision[] }) {
  if (revisions.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No revisions"
        description="If you need to change a PO after sending it to the supplier, open a revision (PO.8 ships the diff workflow)."
      />
    )
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <table className="w-full text-base">
        <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
          <tr>
            <th className="text-left font-medium px-4 py-1.5 w-16">v</th>
            <th className="text-left font-medium px-4 py-1.5">Reason</th>
            <th className="text-left font-medium px-4 py-1.5">Status</th>
            <th className="text-left font-medium px-4 py-1.5">Created</th>
            <th className="text-left font-medium px-4 py-1.5">Supplier ack</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((r) => (
            <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
              <td className="px-4 py-2 font-mono tabular-nums">v{r.version}</td>
              <td className="px-4 py-2">
                {r.reason ?? <span className="text-slate-500 dark:text-slate-400">—</span>}
              </td>
              <td className="px-4 py-2">
                <Badge variant="default" size="sm">
                  {r.status}
                </Badge>
              </td>
              <td className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">
                {relativeTime(r.createdAt)}
                {r.createdBy ? ` · ${r.createdBy}` : ''}
              </td>
              <td className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">
                {r.supplierAckedAt
                  ? relativeTime(r.supplierAckedAt)
                  : r.supplierNotifiedAt
                    ? `Notified ${relativeTime(r.supplierNotifiedAt)}`
                    : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CommentsPane({ comments }: { comments: POComment[] }) {
  if (comments.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No comments"
        description="Operators can leave notes and @-mention teammates here. Compose UI ships in PO.7."
      />
    )
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-3">
      {comments.map((c) => (
        <div key={c.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 pb-2 last:pb-0">
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {c.userId ?? 'unknown'}
            </span>
            <span title={new Date(c.createdAt).toLocaleString()}>{relativeTime(c.createdAt)}</span>
          </div>
          <div className="text-base text-slate-900 dark:text-slate-100 whitespace-pre-wrap mt-1">
            {c.body}
          </div>
        </div>
      ))}
    </div>
  )
}
