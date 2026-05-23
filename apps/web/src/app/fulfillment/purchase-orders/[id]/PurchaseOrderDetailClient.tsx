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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Plus,
  Printer,
  ShoppingCart,
  Trash2,
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
import { usePoEvents } from '@/lib/sync/use-po-events'
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
import { PoLiveSyncChip } from '../_shared/PoLiveSyncChip'
import { EditableSummaryPane, isEditableStatus } from '../_shared/EditableSummaryPane'
import { ThreeWayMatchPanel } from '../_shared/ThreeWayMatchPanel'

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

interface RevisionItemSnapshot {
  productId: string | null
  supplierSku: string | null
  sku: string
  quantityOrdered: number
  unitCostCents: number
  note: string | null
}

interface RevisionSnapshot {
  before: RevisionItemSnapshot[]
  after: RevisionItemSnapshot[]
  beforeTotalCents: number
  afterTotalCents: number
}

interface PORevision {
  id: string
  version: number
  reason: string | null
  status: string
  snapshotJson: RevisionSnapshot
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

interface POFiscal {
  piva: string
  vatScheme: string | null
  ivaRateBp: number
  reverseCharge: boolean
  totalNetCents: number
  ivaCents: number
  totalGrossCents: number
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
  // PO.12 — fiscal block, null when brand.piva is unset.
  fiscal: POFiscal | null
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

  // PO.4 — both event streams open. PO events drive the page's
  // primary hot path (transitioned / received / updated); inbound
  // events still bleed in for receive flows that don't emit a PO
  // event yet. The dual subscription is cheap (one EventSource each)
  // and a single useInvalidationChannel collapses both into one
  // refresh.
  useInboundEvents()
  const { connected: poStreamConnected, lastEventAt: poStreamLastEventAt } = usePoEvents()
  useInvalidationChannel(
    [
      'inbound.received',
      'inbound.updated',
      'inbound.discrepancy',
      'inbound.created',
      'po.updated',
      'po.transitioned',
      'po.received',
      'po.deleted',
      'po.restored',
    ],
    useCallback(
      (event) => {
        // Refresh only when the event targets this PO (when id is
        // available) or when it's a list-wide invalidation.
        if (!event.id || event.id === id) refresh()
      },
      [refresh, id],
    ),
  )

  // PO.9 — populated when the operator just hit Send so the page can
  // render the freshly-minted ack URL + email-delivery status.
  const [sendResult, setSendResult] = useState<{
    ackUrl: string
    emailDelivery: { sent: boolean; dryRun: boolean; error?: string; skipped?: boolean }
  } | null>(null)

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
        const body = await res.json().catch(() => ({}))
        // PO.9 — surface the supplier-email outcome when the send
        // transition runs.
        if (transition === 'send' && body?.supplierEmail) {
          setSendResult({
            ackUrl: body.supplierEmail.ackUrl,
            emailDelivery: body.supplierEmail.emailDelivery,
          })
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
              <PoLiveSyncChip
                connected={poStreamConnected}
                lastEventAt={poStreamLastEventAt}
              />
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

        {/* PO.9 — supplier-email send result banner. Operator clicks
            Send, sees the freshly-minted ack URL + delivery state. */}
        {sendResult && (
          <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded p-3 space-y-2 po-detail-no-print">
            <div className="flex items-center gap-2 text-base text-blue-900 dark:text-blue-100 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              {sendResult.emailDelivery.sent
                ? 'Sent to supplier'
                : sendResult.emailDelivery.dryRun
                  ? 'Email skipped (dry-run mode); ack link minted'
                  : sendResult.emailDelivery.error
                    ? `Email did not send: ${sendResult.emailDelivery.error}`
                    : 'Ack link minted (email skipped)'}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                readOnly
                value={sendResult.ackUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 h-8 px-2 text-sm font-mono border border-blue-200 dark:border-blue-900 rounded bg-white dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(sendResult.ackUrl)}
                className="h-8 px-3 text-sm rounded border border-blue-200 dark:border-blue-900 bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-blue-950/40"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setSendResult(null)}
                className="h-8 px-3 text-sm rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Dismiss
              </button>
            </div>
            <div className="text-sm text-blue-800 dark:text-blue-200">
              Share this URL with the supplier if the email doesn't reach them. They can confirm or decline from the link.
            </div>
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

        {/* PO.12 — Italian fiscal strip. Renders only when BrandSettings
            has piva (i.e. operator is Italian). Reverse-charge case
            zeroes the IVA and shows a banner; otherwise the standard
            22% breakdown. */}
        {po.fiscal && (
          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                Italian fiscal · P.IVA {po.fiscal.piva}
                {po.fiscal.vatScheme ? ` · ${po.fiscal.vatScheme}` : ''}
              </span>
              {po.fiscal.reverseCharge && (
                <span className="text-sm text-amber-700 dark:text-amber-300">
                  Reverse charge — IVA accounted by buyer (Art. 17(6) DPR 633/72)
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 mt-2 text-base">
              <FiscalCell
                label="Imponibile"
                value={formatCurrency(po.fiscal.totalNetCents, po.currencyCode)}
              />
              <FiscalCell
                label={
                  po.fiscal.reverseCharge
                    ? 'IVA (reverse-charged)'
                    : `IVA ${(po.fiscal.ivaRateBp / 100).toFixed(0)}%`
                }
                value={
                  po.fiscal.reverseCharge
                    ? '—'
                    : formatCurrency(po.fiscal.ivaCents, po.currencyCode)
                }
              />
              <FiscalCell
                label="Totale"
                value={formatCurrency(po.fiscal.totalGrossCents, po.currencyCode)}
                bold
              />
            </div>
          </div>
        )}
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
          {isEditableStatus(po.status) ? (
            <EditableSummaryPane po={po} onRefresh={refresh} />
          ) : (
            <div className="space-y-4">
              {/* PO.10 — three-way match surfaces above the read-only
                  line table whenever any quantity has been received,
                  so the operator's eye lands on the variance summary
                  before the raw lines. Panel auto-hides at zero
                  receives. */}
              <ThreeWayMatchPanel poId={po.id} />
              <SummaryPane po={po} />
            </div>
          )}
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
          <RevisionsPane
            poId={po.id}
            poStatus={po.status}
            poCurrency={po.currencyCode}
            revisions={po.revisions}
            onRefresh={refresh}
          />
        </section>
        <section data-tab-pane className={cn(tab !== 'comments' && 'po-detail-no-print')}>
          <CommentsPane poId={po.id} comments={po.comments} onRefresh={refresh} />
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

function FiscalCell({
  label,
  value,
  bold,
}: {
  label: string
  value: string
  bold?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
        {label}
      </div>
      <div
        className={cn(
          'tabular-nums',
          bold ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300',
        )}
      >
        {value}
      </div>
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

// PO.8 — Statuses where opening a revision is allowed. Mirrors the
// server-side REVISABLE_PO_STATUSES set in fulfillment.routes.ts.
const REVISABLE_STATUSES = new Set(['SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL'])

function RevisionsPane({
  poId,
  poStatus,
  poCurrency,
  revisions,
  onRefresh,
}: {
  poId: string
  poStatus: string
  poCurrency: string
  revisions: PORevision[]
  onRefresh: () => void | Promise<void>
}) {
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [showReasonInput, setShowReasonInput] = useState(false)

  const inFlight = revisions.find(
    (r) => r.status === 'PENDING' || r.status === 'SUPPLIER_NOTIFIED',
  )
  const canOpen = REVISABLE_STATUSES.has(poStatus) && !inFlight

  const openRevision = async () => {
    setOpening(true)
    setOpenError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/revisions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() || undefined }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setShowReasonInput(false)
      setReason('')
      await onRefresh()
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Open-revision affordance / explanation */}
      {canOpen && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
          {showReasonInput ? (
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Why are you opening a revision?
              </div>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Supplier quoted +12% on FX; price-match request; qty short-shipped…"
                autoFocus
                className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openRevision}
                  disabled={opening}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border transition-colors bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100 hover:bg-slate-800 disabled:opacity-50"
                >
                  {opening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
                  Open revision
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowReasonInput(false)
                    setReason('')
                  }}
                  className="h-8 px-3 inline-flex items-center text-base font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
              {openError && (
                <div className="text-sm text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {openError}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="text-base text-slate-700 dark:text-slate-300">
                This PO has been sent to the supplier. Direct edits are
                locked — open a revision to propose a change.
              </div>
              <button
                type="button"
                onClick={() => setShowReasonInput(true)}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex-shrink-0"
              >
                <GitBranch className="w-3.5 h-3.5" />
                Open revision
              </button>
            </div>
          )}
        </div>
      )}

      {/* In-flight revision editor */}
      {inFlight && (
        <RevisionEditor
          poId={poId}
          poCurrency={poCurrency}
          revision={inFlight}
          onRefresh={onRefresh}
        />
      )}

      {/* Historical revisions table */}
      {revisions.length === 0 ? (
        !canOpen && (
          <EmptyState
            icon={GitBranch}
            title="No revisions"
            description="If this PO needs to change after the supplier sees it, open a revision here. POs in DRAFT or REVIEW can be edited directly without a revision."
          />
        )
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left font-medium px-4 py-1.5 w-16">v</th>
                <th className="text-left font-medium px-4 py-1.5">Reason</th>
                <th className="text-left font-medium px-4 py-1.5">Status</th>
                <th className="text-right font-medium px-4 py-1.5">Δ Total</th>
                <th className="text-left font-medium px-4 py-1.5">Created</th>
                <th className="text-left font-medium px-4 py-1.5">Supplier ack</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => {
                const delta = r.snapshotJson.afterTotalCents - r.snapshotJson.beforeTotalCents
                const deltaSign = delta > 0 ? '+' : delta < 0 ? '−' : ''
                const deltaCls =
                  delta > 0
                    ? 'text-amber-700 dark:text-amber-300'
                    : delta < 0
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-slate-500 dark:text-slate-400'
                return (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <td className="px-4 py-2 font-mono tabular-nums">v{r.version}</td>
                    <td className="px-4 py-2">
                      {r.reason ?? <span className="text-slate-500 dark:text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={revisionStatusVariant(r.status)} size="sm">
                        {r.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', deltaCls)}>
                      {delta === 0 ? '—' : `${deltaSign}${formatCurrency(Math.abs(delta), poCurrency)}`}
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
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function revisionStatusVariant(
  status: string,
): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'SUPPLIER_ACKED':
      return 'success'
    case 'SUPPLIER_NOTIFIED':
      return 'info'
    case 'PENDING':
      return 'warning'
    case 'CANCELLED':
    case 'SUPERSEDED':
      return 'default'
    default:
      return 'default'
  }
}

// ── Revision editor with side-by-side diff ─────────────────────────

function RevisionEditor({
  poId,
  poCurrency,
  revision,
  onRefresh,
}: {
  poId: string
  poCurrency: string
  revision: PORevision
  onRefresh: () => void | Promise<void>
}) {
  const before = revision.snapshotJson.before
  // Local mutable copy of the proposed (after) items.
  const [items, setItems] = useState<RevisionItemSnapshot[]>(
    revision.snapshotJson.after.map((it) => ({ ...it })),
  )
  const [reason, setReason] = useState<string>(revision.reason ?? '')
  const [saving, setSaving] = useState(false)
  const [savedJustNow, setSavedJustNow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'apply' | 'cancel' | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  // Re-seed when the server pushes a fresh revision (e.g. after a peer
  // edits it via the SSE pipe).
  useEffect(() => {
    setItems(revision.snapshotJson.after.map((it) => ({ ...it })))
    setReason(revision.reason ?? '')
  }, [revision.id, revision.snapshotJson])

  const diff = useMemo(() => computeDiff(before, items), [before, items])
  const afterTotal = items.reduce(
    (s, it) => s + Math.max(0, it.quantityOrdered) * Math.max(0, it.unitCostCents),
    0,
  )
  const deltaCents = afterTotal - revision.snapshotJson.beforeTotalCents

  const scheduleSave = useCallback(() => {
    setSavedJustNow(false)
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/revisions/${revision.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, reason: reason || null }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        setSavedJustNow(true)
        window.setTimeout(() => setSavedJustNow(false), 2000)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    }, 1500)
  }, [poId, revision.id, items, reason])

  const updateItem = (idx: number, patch: Partial<RevisionItemSnapshot>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
    scheduleSave()
  }
  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        productId: null,
        supplierSku: null,
        sku: '',
        quantityOrdered: 1,
        unitCostCents: 0,
        note: null,
      },
    ])
  }
  const removeItem = (idx: number) => {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)))
    scheduleSave()
  }

  const applyRevision = async () => {
    if (!window.confirm(`Apply revision v${revision.version}? This replaces the PO's line items.`)) {
      return
    }
    setBusy('apply')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/revisions/${revision.id}/apply`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const cancelRevision = async () => {
    if (!window.confirm(`Cancel revision v${revision.version}? Edits will be discarded.`)) {
      return
    }
    setBusy('cancel')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/revisions/${revision.id}/cancel`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-blue-200 dark:border-blue-900 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant={revisionStatusVariant(revision.status)} size="md">
            v{revision.version} · {revision.status.replace(/_/g, ' ')}
          </Badge>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Opened {relativeTime(revision.createdAt)}
            {revision.createdBy ? ` by ${revision.createdBy}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Saving…
            </span>
          )}
          {savedJustNow && (
            <span className="text-sm text-green-700 dark:text-green-300 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={cancelRevision}
            disabled={busy !== null}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border bg-white dark:bg-slate-900 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
          >
            {busy === 'cancel' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Cancel revision
          </button>
          <button
            type="button"
            onClick={applyRevision}
            disabled={busy !== null || items.length === 0}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border transition-colors bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Apply revision
          </button>
        </div>
      </div>

      {/* Reason field */}
      <div className="px-4 py-3 border-b border-blue-200 dark:border-blue-900">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
          Reason
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
            scheduleSave()
          }}
          placeholder="Why is this revision needed?"
          className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </div>

      {/* Diff summary */}
      <DiffSummary diff={diff} currency={poCurrency} deltaCents={deltaCents} />

      {/* Editable proposed lines */}
      <div className="bg-white dark:bg-slate-900">
        <div className="px-4 py-2 border-y border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center justify-between">
          <span>Proposed line items</span>
          <button
            type="button"
            onClick={addItem}
            className="text-sm px-2 py-1 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-700 inline-flex items-center gap-1 normal-case font-normal"
          >
            <Plus size={11} /> Add line
          </button>
        </div>
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th className="text-left font-medium px-3 py-1.5 w-12">#</th>
              <th className="text-left font-medium px-3 py-1.5">SKU</th>
              <th className="text-right font-medium px-3 py-1.5 w-24">Qty</th>
              <th className="text-right font-medium px-3 py-1.5 w-32">Unit cost</th>
              <th className="text-right font-medium px-3 py-1.5 w-28">Subtotal</th>
              <th className="text-left font-medium px-3 py-1.5 w-12">Δ</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const change = diffFor(before, it)
              return (
                <tr key={idx} className="border-b border-slate-100 dark:border-slate-800 last:border-0 align-top">
                  <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 tabular-nums">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={it.sku}
                      onChange={(e) => updateItem(idx, { sku: e.target.value, productId: null, supplierSku: null })}
                      className="w-full h-8 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={it.quantityOrdered || ''}
                      onChange={(e) =>
                        updateItem(idx, {
                          quantityOrdered: parseInt(e.target.value, 10) || 0,
                        })
                      }
                      className="w-full h-8 px-2 text-base text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={(it.unitCostCents / 100).toFixed(2)}
                      onChange={(e) => {
                        const raw = e.target.value.replace(',', '.')
                        const n = parseFloat(raw)
                        updateItem(idx, {
                          unitCostCents: Number.isFinite(n) ? Math.round(n * 100) : 0,
                        })
                      }}
                      className="w-full h-8 px-2 text-base text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                    {formatCurrency(it.unitCostCents * it.quantityOrdered, poCurrency)}
                  </td>
                  <td className="px-3 py-2">
                    {change && <ChangeBadge change={change} />}
                  </td>
                  <td className="px-1 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      disabled={items.length === 1}
                      className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-30"
                      aria-label="Remove line"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              )
            })}
            {/* Removed-line rows (present in before, not in items) */}
            {diff.removed.map((it, k) => (
              <tr key={`removed-${k}`} className="border-b border-slate-100 dark:border-slate-800 last:border-0 bg-red-50/30 dark:bg-red-950/20">
                <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">—</td>
                <td className="px-3 py-2 font-mono text-sm text-slate-500 dark:text-slate-400 line-through">
                  {it.sku}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400 line-through">
                  {it.quantityOrdered}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400 line-through">
                  {formatCurrency(it.unitCostCents, poCurrency)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400 line-through">
                  {formatCurrency(it.unitCostCents * it.quantityOrdered, poCurrency)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="danger" size="sm">
                    removed
                  </Badge>
                </td>
                <td></td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700">
            <tr>
              <td colSpan={4} className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                After total
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                {formatCurrency(afterTotal, poCurrency)}
              </td>
              <td colSpan={2} className={cn('px-3 py-2 text-sm', deltaCents > 0 ? 'text-amber-700 dark:text-amber-300' : deltaCents < 0 ? 'text-green-700 dark:text-green-300' : 'text-slate-500 dark:text-slate-400')}>
                {deltaCents === 0
                  ? '— no change'
                  : `${deltaCents > 0 ? '+' : '−'}${formatCurrency(Math.abs(deltaCents), poCurrency)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-900 text-base text-red-700 dark:text-red-300 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}
    </div>
  )
}

// ── Diff helpers ───────────────────────────────────────────────────

interface LineChange {
  kind: 'added' | 'qty' | 'cost' | 'both' | 'note'
  prevQty?: number
  prevCost?: number
}

function diffFor(
  before: RevisionItemSnapshot[],
  item: RevisionItemSnapshot,
): LineChange | null {
  // Match on sku — the only stable identifier across before/after.
  if (!item.sku.trim()) return null
  const prior = before.find((b) => b.sku === item.sku)
  if (!prior) return { kind: 'added' }
  const qtyChanged = prior.quantityOrdered !== item.quantityOrdered
  const costChanged = prior.unitCostCents !== item.unitCostCents
  if (qtyChanged && costChanged) {
    return {
      kind: 'both',
      prevQty: prior.quantityOrdered,
      prevCost: prior.unitCostCents,
    }
  }
  if (qtyChanged) return { kind: 'qty', prevQty: prior.quantityOrdered }
  if (costChanged) return { kind: 'cost', prevCost: prior.unitCostCents }
  if ((prior.note ?? '') !== (item.note ?? '')) return { kind: 'note' }
  return null
}

function computeDiff(
  before: RevisionItemSnapshot[],
  after: RevisionItemSnapshot[],
): {
  added: RevisionItemSnapshot[]
  removed: RevisionItemSnapshot[]
  modified: Array<{ sku: string; prior: RevisionItemSnapshot; next: RevisionItemSnapshot }>
} {
  const afterBySku = new Map(after.map((it) => [it.sku, it]))
  const beforeBySku = new Map(before.map((it) => [it.sku, it]))
  const added = after.filter((it) => it.sku.trim() && !beforeBySku.has(it.sku))
  const removed = before.filter((it) => !afterBySku.has(it.sku))
  const modified: Array<{ sku: string; prior: RevisionItemSnapshot; next: RevisionItemSnapshot }> = []
  for (const a of after) {
    const b = beforeBySku.get(a.sku)
    if (!b) continue
    if (
      b.quantityOrdered !== a.quantityOrdered ||
      b.unitCostCents !== a.unitCostCents ||
      (b.note ?? '') !== (a.note ?? '')
    ) {
      modified.push({ sku: a.sku, prior: b, next: a })
    }
  }
  return { added, removed, modified }
}

function DiffSummary({
  diff,
  currency,
  deltaCents,
}: {
  diff: ReturnType<typeof computeDiff>
  currency: string
  deltaCents: number
}) {
  const noChanges =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.modified.length === 0
  return (
    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <div className="flex items-center gap-3 text-base flex-wrap">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Changes
        </span>
        {noChanges ? (
          <span className="text-slate-500 dark:text-slate-400">
            No changes yet — edit the lines below to propose a revision.
          </span>
        ) : (
          <>
            {diff.added.length > 0 && (
              <span className="text-green-700 dark:text-green-300">
                +{diff.added.length} added
              </span>
            )}
            {diff.removed.length > 0 && (
              <span className="text-red-700 dark:text-red-300">
                −{diff.removed.length} removed
              </span>
            )}
            {diff.modified.length > 0 && (
              <span className="text-amber-700 dark:text-amber-300">
                {diff.modified.length} modified
              </span>
            )}
            <span
              className={cn(
                'ml-auto text-sm',
                deltaCents > 0
                  ? 'text-amber-700 dark:text-amber-300'
                  : deltaCents < 0
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-slate-500 dark:text-slate-400',
              )}
            >
              Total Δ:{' '}
              {deltaCents === 0
                ? '—'
                : `${deltaCents > 0 ? '+' : '−'}${formatCurrency(Math.abs(deltaCents), currency)}`}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function ChangeBadge({ change }: { change: LineChange }) {
  if (change.kind === 'added') {
    return (
      <Badge variant="success" size="sm">
        added
      </Badge>
    )
  }
  if (change.kind === 'note') {
    return (
      <Badge variant="default" size="sm">
        note
      </Badge>
    )
  }
  return (
    <Badge variant="warning" size="sm">
      modified
    </Badge>
  )
}

function CommentsPane({
  poId,
  comments,
  onRefresh,
}: {
  poId: string
  comments: POComment[]
  onRefresh: () => void | Promise<void>
}) {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lightweight @-mention extractor. Matches '@' followed by an email
  // address OR a contiguous word (the user types either a teammate's
  // email or a free-form @handle that future user-resolution can map).
  const extractMentions = useCallback((text: string): string[] => {
    const out = new Set<string>()
    const re = /@([\w.+-]+(?:@[\w.-]+)?)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out.add(m[1])
    }
    return [...out]
  }, [])

  const submit = async () => {
    const trimmed = body.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: trimmed,
            mentions: extractMentions(trimmed),
          }),
        },
      )
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b?.error ?? `HTTP ${res.status}`)
      }
      setBody('')
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (commentId: string) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/comments/${commentId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b?.error ?? `HTTP ${res.status}`)
      }
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-3">
      {/* Composer */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Add a comment… (@-mention to ping a teammate)"
          rows={2}
          disabled={submitting}
          className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            ⌘+Enter to post
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !body.trim()}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-base font-medium rounded border transition-colors disabled:opacity-50 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100 hover:bg-slate-800 dark:hover:bg-slate-200"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <MessageSquare className="w-3.5 h-3.5" />
            )}
            Post
          </button>
        </div>
        {error && (
          <div className="text-sm text-red-700 dark:text-red-300 mt-2 inline-flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {error}
          </div>
        )}
      </div>

      {/* Thread */}
      {comments.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No comments yet"
          description="The first comment lands here."
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-3">
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} onDelete={() => remove(c.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function CommentRow({
  comment,
  onDelete,
}: {
  comment: POComment
  onDelete: () => void | Promise<void>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Render the body with @-mentions highlighted as inline chips.
  const renderBody = (text: string) => {
    const parts: React.ReactNode[] = []
    let lastIdx = 0
    const re = /@([\w.+-]+(?:@[\w.-]+)?)/g
    let m: RegExpExecArray | null
    let key = 0
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index))
      parts.push(
        <span
          key={key++}
          className="inline-block px-1.5 py-0.5 mx-0.5 text-sm font-medium bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded"
        >
          @{m[1]}
        </span>,
      )
      lastIdx = m.index + m[0].length
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx))
    return parts
  }
  return (
    <div className="border-b border-slate-100 dark:border-slate-800 last:border-0 pb-2 last:pb-0 group">
      <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-300">
          {comment.userId ?? 'operator'}
        </span>
        <span title={new Date(comment.createdAt).toLocaleString()}>
          {relativeTime(comment.createdAt)}
        </span>
        {comment.mentions.length > 0 && (
          <span className="text-slate-400 dark:text-slate-500">
            · pinged {comment.mentions.length}
          </span>
        )}
        <span className="flex-1" />
        {confirmDelete ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onDelete}
              className="text-sm text-red-700 dark:text-red-300 hover:underline"
            >
              Delete?
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-sm text-slate-500 dark:text-slate-400 hover:underline"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="opacity-0 group-hover:opacity-100 text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity"
          >
            Delete
          </button>
        )}
      </div>
      <div className="text-base text-slate-900 dark:text-slate-100 whitespace-pre-wrap mt-1">
        {renderBody(comment.body)}
      </div>
    </div>
  )
}
