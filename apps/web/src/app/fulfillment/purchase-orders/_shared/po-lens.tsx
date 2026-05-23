'use client'

// PO.3 — shared types + presentation helpers for the
// /fulfillment/purchase-orders workspace.
//
// Hoisted from PurchaseOrdersClient.tsx + the [id]/PurchaseOrderDetailClient
// so the list (table + card lens) and the detail page draw their badges,
// transitions, and money formatting from a single source.

import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileCheck2,
  FileText,
  PackageCheck,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

export interface POItem {
  id: string
  productId: string | null
  sku: string
  supplierSku?: string | null
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
  note?: string | null
  lineOrder?: number
}

export type PoStatus =
  | 'DRAFT'
  | 'REVIEW'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'CONFIRMED'
  | 'PARTIAL'
  | 'RECEIVED'
  | 'CANCELLED'

export interface PORow {
  id: string
  poNumber: string
  supplierId: string | null
  supplier: { id: string; name: string } | null
  warehouseId: string | null
  warehouse: { code: string } | null
  status: PoStatus
  totalCents: number
  currencyCode: string
  notes: string | null
  expectedDeliveryDate: string | null
  supplierConfirmedDeliveryDate?: string | null
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

export type StatusFilter =
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
export const STATUS_FILTERS: ReadonlyArray<{ key: StatusFilter; labelKey: string }> = [
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
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SUBMITTED',
])

// ── Formatters ─────────────────────────────────────────────────────

export function relativeTime(iso: string | null | undefined): string {
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

export function formatCurrency(cents: number, code: string): string {
  const amount = cents / 100
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

// ── Status presentation ────────────────────────────────────────────

export function statusVariant(
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

export function StatusIcon({
  status,
  className,
}: {
  status: string
  className?: string
}) {
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

// ── State machine ──────────────────────────────────────────────────

export type WorkflowTransition =
  | 'submit-for-review'
  | 'approve'
  | 'send'
  | 'acknowledge'
  | 'cancel'

export interface TransitionDef {
  key: WorkflowTransition
  labelKey: string
  variant: 'primary' | 'secondary' | 'danger'
  icon: typeof Send
  destructive?: boolean
}

// Mirrors po-workflow.service.ts:nextStatus(). Keep in sync if the
// backend state machine changes.
export function availableTransitions(status: string): TransitionDef[] {
  switch (status) {
    case 'DRAFT':
      return [
        {
          key: 'submit-for-review',
          labelKey: 'po.transition.submitForReview',
          variant: 'primary',
          icon: ChevronRight,
        },
        {
          key: 'cancel',
          labelKey: 'po.transition.cancel',
          variant: 'danger',
          icon: Ban,
          destructive: true,
        },
      ]
    case 'REVIEW':
      return [
        {
          key: 'approve',
          labelKey: 'po.transition.approve',
          variant: 'primary',
          icon: FileCheck2,
        },
        {
          key: 'cancel',
          labelKey: 'po.transition.cancel',
          variant: 'danger',
          icon: Ban,
          destructive: true,
        },
      ]
    case 'APPROVED':
      return [
        { key: 'send', labelKey: 'po.transition.send', variant: 'primary', icon: Send },
        {
          key: 'cancel',
          labelKey: 'po.transition.cancel',
          variant: 'danger',
          icon: Ban,
          destructive: true,
        },
      ]
    case 'SUBMITTED':
      return [
        {
          key: 'acknowledge',
          labelKey: 'po.transition.acknowledge',
          variant: 'primary',
          icon: CheckCircle2,
        },
      ]
    default:
      return []
  }
}

// ── Overdue / urgency ──────────────────────────────────────────────
//
// A PO is "overdue" when its expectedDeliveryDate has passed AND it's
// not in a terminal state. Surfaces in red on the row so the operator
// knows the supplier missed their commitment.
export function isPoOverdue(
  expectedDeliveryDate: string | null | undefined,
  status: string,
): boolean {
  if (!expectedDeliveryDate) return false
  if (status === 'RECEIVED' || status === 'CANCELLED') return false
  return new Date(expectedDeliveryDate).getTime() < Date.now()
}
