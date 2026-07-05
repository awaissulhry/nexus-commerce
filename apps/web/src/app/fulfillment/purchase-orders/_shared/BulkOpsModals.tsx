'use client'

// PO-Plus.5 — Bulk re-assign supplier + bulk merge modals.
//
// Both are triggered from the sticky bulk-action bar on
// /fulfillment/purchase-orders. The bar passes the selected PO ids
// + their snapshot rows (so the modals can pre-validate without a
// backend round-trip on cancel) plus an onDone callback that
// invalidates the list and clears selection.

import { useEffect, useState } from 'react'
import { Listbox } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  GitMerge,
  Loader2,
  UserCog,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { formatCurrency, type PORow } from './po-lens'

interface SupplierOption {
  id: string
  name: string
  isActive: boolean
}

// ── Bulk re-assign supplier ────────────────────────────────────────

interface ReassignResult {
  targetSupplierId: string | null
  succeeded: Array<{ poId: string; poNumber: string }>
  skipped: Array<{ poId: string; reason: string }>
  failed: Array<{ poId: string; error: string }>
  total: number
}

export function BulkReassignSupplierModal({
  selectedRows,
  onClose,
  onDone,
}: {
  selectedRows: PORow[]
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const [supplierId, setSupplierId] = useState<string>('')
  const [suppliers, setSuppliers] = useState<SupplierOption[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReassignResult | null>(null)

  useEffect(() => {
    fetch(`${getBackendUrl()}/api/fulfillment/suppliers?activeOnly=true`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setSuppliers(d.items ?? []))
      .catch(() => setSuppliers([]))
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [submitting, onClose])

  const editableCount = selectedRows.filter(
    (p) => p.status === 'DRAFT' || p.status === 'REVIEW',
  ).length
  const lockedCount = selectedRows.length - editableCount

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/bulk-reassign-supplier`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: selectedRows.map((p) => p.id),
            supplierId: supplierId || null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as ReassignResult
      setResult(data)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Shell
      icon={<UserCog className="w-4 h-4" />}
      title={`Re-assign supplier on ${selectedRows.length} PO${selectedRows.length === 1 ? '' : 's'}`}
      onClose={onClose}
      disabled={submitting}
    >
      {result ? (
        <ResultBlock
          succeeded={result.succeeded.map((r) => ({ label: r.poNumber, sub: 'updated' }))}
          skipped={result.skipped.map((r) => ({ label: r.poId.slice(0, 10), reason: r.reason }))}
          failed={result.failed.map((r) => ({ label: r.poId.slice(0, 10), reason: r.error }))}
          totalLabel={`${result.succeeded.length} of ${result.total} re-assigned`}
          onDone={onClose}
        />
      ) : (
        <>
          {lockedCount > 0 && (
            <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-3 py-2 inline-flex items-center gap-2 w-full">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {lockedCount} PO{lockedCount === 1 ? '' : 's'} {lockedCount === 1 ? 'is' : 'are'}{' '}
              past DRAFT/REVIEW and will be skipped. Open a revision to
              change their supplier instead.
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
              Target supplier
            </label>
            <Listbox value={supplierId} onChange={setSupplierId} disabled={submitting} ariaLabel="Target supplier"
              options={[{ value: '', label: '— Clear supplier —' }, ...(suppliers ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Currency and lead-time defaults from the new supplier are
              NOT auto-applied. Edit each PO afterward if those defaults
              actually differ.
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800 rounded p-3 max-h-40 overflow-y-auto">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Affecting:
            </div>
            <ul className="text-sm space-y-0.5 font-mono">
              {selectedRows.slice(0, 10).map((p) => (
                <li key={p.id} className="text-slate-700 dark:text-slate-300">
                  {p.poNumber}{' '}
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-sans">
                    · {p.status} · current: {p.supplier?.name ?? '—'}
                  </span>
                </li>
              ))}
              {selectedRows.length > 10 && (
                <li className="text-xs text-slate-500 dark:text-slate-400 font-sans">
                  …and {selectedRows.length - 10} more
                </li>
              )}
            </ul>
          </div>

          {error && (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </>
      )}

      {!result && (
        <Footer
          submitting={submitting}
          onClose={onClose}
          onSubmit={submit}
          submitLabel={`Re-assign ${editableCount} PO${editableCount === 1 ? '' : 's'}`}
          submitIcon={<UserCog className="w-3.5 h-3.5" />}
          disabled={editableCount === 0}
        />
      )}
    </Shell>
  )
}

// ── Bulk merge ────────────────────────────────────────────────────

interface MergeResult {
  ok: true
  newPoId: string
  newPoNumber: string
  mergedFromCount: number
  mergedLines: number
  totalCents: number
}

export function BulkMergeModal({
  selectedRows,
  onClose,
  onDone,
}: {
  selectedRows: PORow[]
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MergeResult | null>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [submitting, onClose])

  // Pre-flight validation — backend re-validates server-side, but a
  // client-side check gives instant feedback before a network trip.
  const validation = preflightMerge(selectedRows)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/bulk-merge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: selectedRows.map((p) => p.id),
            targetNotes: notes.trim() || undefined,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as MergeResult
      setResult(data)
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const sharedSupplier = selectedRows[0]?.supplier?.name ?? null
  const sharedCurrency = selectedRows[0]?.currencyCode ?? 'EUR'
  // Pre-compute the deduplicated total line count so the operator sees
  // "Merging 4 POs (18 lines) into 1 PO (12 unique SKUs)" before they
  // commit.
  const uniqueLines = countUniqueSkus(selectedRows)
  const totalLines = selectedRows.reduce((s, p) => s + p.items.length, 0)
  const totalCentsSum = selectedRows.reduce((s, p) => s + p.totalCents, 0)

  return (
    <Shell
      icon={<GitMerge className="w-4 h-4" />}
      title={`Merge ${selectedRows.length} PO${selectedRows.length === 1 ? '' : 's'} into one`}
      onClose={onClose}
      disabled={submitting}
    >
      {result ? (
        <div className="space-y-3 text-base">
          <div className="inline-flex items-center gap-2 text-green-700 dark:text-green-300 font-semibold">
            <CheckCircle2 className="w-4 h-4" />
            Merge complete
          </div>
          <p className="text-slate-700 dark:text-slate-300">
            Created{' '}
            <a
              href={`/fulfillment/purchase-orders/${result.newPoId}`}
              className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
            >
              {result.newPoNumber}
            </a>{' '}
            with {result.mergedLines} line{result.mergedLines === 1 ? '' : 's'} and total{' '}
            <span className="font-semibold">
              {formatCurrency(result.totalCents, sharedCurrency)}
            </span>
            . The {result.mergedFromCount} source PO
            {result.mergedFromCount === 1 ? '' : 's'} {result.mergedFromCount === 1 ? 'has' : 'have'}{' '}
            been cancelled with a "Merged into {result.newPoNumber}" note.
          </p>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <>
          {validation.error ? (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Cannot merge:</div>
                <div>{validation.error}</div>
              </div>
            </div>
          ) : (
            <div className="text-base text-slate-700 dark:text-slate-300 bg-blue-50/40 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded p-3">
              <div>
                Merging <strong>{selectedRows.length}</strong> POs (
                <strong>{totalLines}</strong> total lines →{' '}
                <strong>{uniqueLines}</strong> unique SKUs) into one DRAFT PO.
              </div>
              <ul className="text-sm text-slate-500 dark:text-slate-400 mt-2 space-y-0.5">
                <li>• Supplier: <strong>{sharedSupplier ?? '—'}</strong></li>
                <li>• Currency: <strong>{sharedCurrency}</strong></li>
                <li>
                  • Items dedup by SKU — qty summed, cost is qty-weighted
                  average
                </li>
                <li>• Source POs will be cancelled (recoverable from recycle bin)</li>
                <li>
                  • Combined total{' '}
                  <strong>{formatCurrency(totalCentsSum, sharedCurrency)}</strong>{' '}
                  (post-dedup will be the same)
                </li>
              </ul>
            </div>
          )}

          <div className="bg-slate-50 dark:bg-slate-800 rounded p-3 max-h-40 overflow-y-auto">
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Source POs:
            </div>
            <ul className="text-sm space-y-0.5 font-mono">
              {selectedRows.map((p) => (
                <li key={p.id} className="text-slate-700 dark:text-slate-300">
                  {p.poNumber}{' '}
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-sans">
                    · {p.status} · {p.items.length} lines ·{' '}
                    {formatCurrency(p.totalCents, p.currencyCode)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {!validation.error && (
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1">
                Notes on the merged PO (optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Defaults to 'Merged from PO-XXX, PO-YYY, ...'"
                disabled={submitting}
                className="w-full px-2 py-1.5 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {error && (
            <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </>
      )}

      {!result && (
        <Footer
          submitting={submitting}
          onClose={onClose}
          onSubmit={submit}
          submitLabel="Merge"
          submitIcon={<GitMerge className="w-3.5 h-3.5" />}
          disabled={!!validation.error}
        />
      )}
    </Shell>
  )
}

// ── Pre-flight validation (client side; backend re-validates) ──────

function preflightMerge(rows: PORow[]): { error?: string } {
  if (rows.length < 2) return { error: 'Select at least 2 POs to merge.' }
  const nonDraft = rows.filter((r) => r.status !== 'DRAFT')
  if (nonDraft.length > 0) {
    return {
      error: `All POs must be DRAFT. ${nonDraft.length} are not (${nonDraft.map((r) => r.poNumber).join(', ')}).`,
    }
  }
  const supplierIds = [...new Set(rows.map((r) => r.supplier?.id ?? null))]
  if (supplierIds.length > 1 || supplierIds[0] === null) {
    return {
      error: 'All POs must share the same (non-null) supplier. Cancel and pick a uniform set.',
    }
  }
  const currencies = [...new Set(rows.map((r) => r.currencyCode))]
  if (currencies.length > 1) {
    return {
      error: `All POs must share the same currency. Found: ${currencies.join(', ')}.`,
    }
  }
  const warehouses = [...new Set(rows.map((r) => r.warehouseId))]
  if (warehouses.length > 1) {
    return {
      error: 'All POs must ship to the same warehouse.',
    }
  }
  return {}
}

function countUniqueSkus(rows: PORow[]): number {
  const set = new Set<string>()
  for (const r of rows) for (const it of r.items) set.add(`${it.productId ?? ''}|${it.sku}`)
  return set.size
}

// ── Shared modal shell + result block ──────────────────────────────

function Shell({
  icon,
  title,
  children,
  onClose,
  disabled,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  onClose: () => void
  disabled: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !disabled) onClose()
      }}
    >
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-slate-900 border-b border-default dark:border-slate-700 px-5 py-3 flex items-center justify-between gap-2 z-10">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            {icon}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={disabled}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  )
}

function Footer({
  submitting,
  onClose,
  onSubmit,
  submitLabel,
  submitIcon,
  disabled,
}: {
  submitting: boolean
  onClose: () => void
  onSubmit: () => void | Promise<void>
  submitLabel: string
  submitIcon: React.ReactNode
  disabled?: boolean
}) {
  return (
    <div className="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-default dark:border-slate-700 px-5 py-3 flex items-center justify-end gap-2 -mx-5 -mb-5 mt-5">
      <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={onSubmit}
        disabled={submitting || disabled}
      >
        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : submitIcon}
        {submitLabel}
      </Button>
    </div>
  )
}

function ResultBlock({
  succeeded,
  skipped,
  failed,
  totalLabel,
  onDone,
}: {
  succeeded: Array<{ label: string; sub?: string }>
  skipped: Array<{ label: string; reason: string }>
  failed: Array<{ label: string; reason: string }>
  totalLabel: string
  onDone: () => void
}) {
  return (
    <div className="space-y-3 text-base">
      <div className="font-semibold text-slate-900 dark:text-slate-100">{totalLabel}</div>
      {succeeded.length > 0 && (
        <Section
          tone="green"
          icon={<CheckCircle2 className="w-3 h-3" />}
          label="Succeeded"
          items={succeeded.map((s) => ({ label: s.label, reason: s.sub }))}
        />
      )}
      {skipped.length > 0 && (
        <Section
          tone="slate"
          icon={<ArrowRight className="w-3 h-3" />}
          label="Skipped"
          items={skipped}
        />
      )}
      {failed.length > 0 && (
        <Section
          tone="red"
          icon={<AlertCircle className="w-3 h-3" />}
          label="Failed"
          items={failed}
        />
      )}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function Section({
  tone,
  icon,
  label,
  items,
}: {
  tone: 'green' | 'red' | 'slate'
  icon: React.ReactNode
  label: string
  items: Array<{ label: string; reason?: string }>
}) {
  const toneCls = {
    green: 'text-green-700 dark:text-green-300',
    red: 'text-red-700 dark:text-red-300',
    slate: 'text-slate-700 dark:text-slate-300',
  } as const
  return (
    <div>
      <div className={cn('text-sm font-semibold inline-flex items-center gap-1 mb-1', toneCls[tone])}>
        {icon}
        {label}
      </div>
      <ul className="text-sm ml-4 list-disc space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className={toneCls[tone]}>
            <span className="font-mono">{it.label}</span>
            {it.reason && (
              <span className="text-slate-500 dark:text-slate-400 font-sans"> — {it.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
