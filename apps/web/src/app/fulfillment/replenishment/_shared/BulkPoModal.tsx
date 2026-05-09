'use client'

/**
 * W9.6h — Bulk PO modal (F.6 origin) + PoSuccessRow + buildSupplierMailto.
 *
 * Extracted from ReplenishmentWorkspace.tsx. Modal that takes the
 * selected suggestions, groups them by preferredSupplierId, lets the
 * operator override quantities, and POSTs to /bulk-draft-po creating
 * one DRAFT PO per supplier. Success state shows per-PO download
 * links + mailto-supplier action.
 *
 * Three components in this file because they're only used together:
 *   BulkPoModal           the modal shell + form + grouped list
 *   PoSuccessRow          one row in the success panel; mailto + PDF
 *   buildSupplierMailto   pure helper — RFC 6068 mailto: URL builder
 *
 * Adds dark-mode classes throughout (modal backdrop, panel surface,
 * supplier-grouped sections, qty inputs, action buttons, success
 * panel rows, work-order pills, footer status line).
 */

import { useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Factory,
  FileText,
  Loader2,
  Mail,
  ShoppingCart,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { Suggestion } from './types'

export function BulkPoModal({
  suggestions,
  onClose,
  onSuccess,
}: {
  suggestions: Suggestion[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      suggestions.map((s) => [s.productId, s.reorderQuantity]),
    ),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // F.6 — After successful submit, hold the created POs locally so we can
  // render a results screen with per-PO "Download factory PDF" links
  // instead of the previous alert+close flow.
  const [createdPos, setCreatedPos] = useState<
    Array<{
      id: string
      poNumber: string
      supplierId: string | null
      supplierName: string | null
      supplierEmail: string | null
      itemCount: number
      totalUnits: number
    }> | null
  >(null)
  const [createdWorkOrders, setCreatedWorkOrders] = useState<
    Array<{ id: string; productId: string; quantity: number }> | null
  >(null)

  // Group by supplier so the user sees how many POs will get created.
  const grouped = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    for (const s of suggestions) {
      const key = s.preferredSupplierId ?? '__no_supplier__'
      const arr = m.get(key) ?? []
      arr.push(s)
      m.set(key, arr)
    }
    return m
  }, [suggestions])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      // R.3 — link each PO line back to its source recommendation +
      // audit any quantity override (when user changed qty from the
      // suggested value).
      const items = suggestions.map((s) => {
        const finalQty = quantities[s.productId] ?? s.reorderQuantity
        const overridden = finalQty !== s.reorderQuantity
        return {
          productId: s.productId,
          quantity: finalQty,
          supplierId: s.preferredSupplierId,
          recommendationId: s.recommendationId ?? null,
          quantityOverride: overridden ? finalQty : null,
          overrideNotes: overridden
            ? `Operator override: ${s.reorderQuantity} → ${finalQty} via bulk PO modal`
            : null,
        }
      })
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/bulk-draft-po`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setCreatedPos(json.createdPos)
      setCreatedWorkOrders(json.createdWorkOrders ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const finishAndClose = () => {
    onSuccess()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {createdPos
                ? `Created ${createdPos.length} draft PO${createdPos.length === 1 ? '' : 's'}`
                : 'Bulk-create draft POs'}
            </div>
            <div className="text-base text-slate-500 dark:text-slate-400 mt-0.5">
              {createdPos
                ? 'Review each PO and download the factory-ready PDF.'
                : `${suggestions.length} item${suggestions.length === 1 ? '' : 's'} · ${grouped.size} supplier${grouped.size === 1 ? '' : 's'} → one PO per supplier`}
            </div>
          </div>
          <button
            onClick={createdPos ? finishAndClose : onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* F.6 + Constraint #2/#5 — Success state with download links per
            PO, email-to-supplier mailto: action, and Work Order separation. */}
        {createdPos ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <div className="text-base text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              <span>
                All POs land as DRAFT. Open each PDF, review with the factory,
                and submit when you're ready.
              </span>
            </div>

            {createdPos.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
                  Purchase orders
                </div>
                <div className="space-y-1.5">
                  {createdPos.map((po) => (
                    <PoSuccessRow key={po.id} po={po} />
                  ))}
                </div>
              </div>
            )}

            {createdWorkOrders && createdWorkOrders.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wider text-violet-700 dark:text-violet-400 font-semibold mb-1.5 inline-flex items-center gap-1">
                  <Factory size={10} /> Work orders (manufactured items)
                </div>
                <div className="space-y-1.5">
                  {createdWorkOrders.map((wo) => (
                    <div
                      key={wo.id}
                      className="border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/30 rounded px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-base font-mono text-slate-900 dark:text-slate-100">
                          WO {wo.id.slice(-10)}
                        </div>
                        <div className="text-sm text-slate-500 dark:text-slate-400">
                          {wo.quantity} units · status PLANNED
                        </div>
                      </div>
                      <span className="text-xs uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-950/60 border border-violet-200 dark:border-violet-900 px-1.5 py-0.5 rounded">
                        Manufacturing
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {Array.from(grouped.entries()).map(([supplierKey, items]) => (
              <div key={supplierKey} className="mb-3 last:mb-0">
                <div
                  className={cn(
                    'text-sm uppercase tracking-wider font-semibold mb-1.5',
                    supplierKey === '__no_supplier__'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400',
                  )}
                >
                  {supplierKey === '__no_supplier__' ? (
                    <span className="inline-flex items-center gap-1">
                      <AlertCircle size={11} /> No supplier set — grouped into a
                      single PO you'll need to assign before submit
                    </span>
                  ) : (
                    <>
                      Supplier {supplierKey.slice(-8)} · {items.length} item
                      {items.length === 1 ? '' : 's'}
                    </>
                  )}
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded">
                  {items.map((s) => (
                    <div
                      key={s.productId}
                      className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0 text-base"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-slate-800 dark:text-slate-200 truncate">
                          {s.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                          {s.sku}
                        </div>
                      </div>
                      <input
                        type="number"
                        min={1}
                        value={quantities[s.productId] ?? s.reorderQuantity}
                        onChange={(e) =>
                          setQuantities((prev) => ({
                            ...prev,
                            [s.productId]:
                              parseInt(e.target.value, 10) || s.reorderQuantity,
                          }))
                        }
                        className="w-20 h-7 px-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded text-base tabular-nums text-right"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
          {error ? (
            <span className="text-base text-rose-700 dark:text-rose-400 inline-flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </span>
          ) : createdPos ? (
            <span className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> Done — close to refresh the workspace
            </span>
          ) : (
            <span className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> All POs land as DRAFT — review before
              submitting
            </span>
          )}
          <div className="flex items-center gap-2">
            {createdPos ? (
              <button
                onClick={finishAndClose}
                className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-500 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5"
              >
                <CheckCircle2 size={12} /> Close
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-500 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" /> Creating…
                    </>
                  ) : (
                    <>
                      <ShoppingCart size={12} /> Create {grouped.size} draft PO
                      {grouped.size === 1 ? '' : 's'}
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Constraint #2 — Per-PO success row with Factory PDF + Email supplier
// actions. Email path uses mailto: with subject + body pre-filled and a
// link to the PDF endpoint; user attaches the actual PDF manually
// (mailto: doesn't support attachments). Email button is disabled with
// a clear "no email on supplier" tooltip when supplier.email is missing.
function PoSuccessRow({
  po,
}: {
  po: {
    id: string
    poNumber: string
    supplierId: string | null
    supplierName: string | null
    supplierEmail: string | null
    itemCount: number
    totalUnits: number
  }
}) {
  const pdfUrl = `${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`
  const mailtoUrl = po.supplierEmail
    ? buildSupplierMailto({
        to: po.supplierEmail,
        supplierName: po.supplierName,
        poNumber: po.poNumber,
        itemCount: po.itemCount,
        totalUnits: po.totalUnits,
        pdfUrl,
      })
    : null
  const copyEmail = po.supplierEmail
    ? () => navigator.clipboard?.writeText(po.supplierEmail!)
    : null
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded px-3 py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-md font-mono font-medium text-slate-900 dark:text-slate-100">
          {po.poNumber}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {po.itemCount} item{po.itemCount === 1 ? '' : 's'} · {po.totalUnits}{' '}
          units
          {po.supplierName ? (
            <> · {po.supplierName}</>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              {' '}
              · no supplier assigned
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {mailtoUrl ? (
          <a
            href={mailtoUrl}
            className="h-7 px-2.5 text-base border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            title={`Email ${po.supplierEmail}`}
          >
            <Mail size={12} /> Email
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="h-7 px-2.5 text-base border border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-600 rounded cursor-not-allowed inline-flex items-center gap-1.5"
            title={
              po.supplierId
                ? 'Supplier has no email on file — set it in Suppliers'
                : 'No supplier assigned'
            }
          >
            <Mail size={12} /> Email
          </button>
        )}
        {copyEmail && (
          <button
            type="button"
            onClick={copyEmail}
            className="h-7 px-2 text-base border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
            title="Copy supplier email to clipboard"
          >
            <Copy size={12} />
          </button>
        )}
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="h-7 px-3 text-base bg-blue-600 dark:bg-blue-500 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5"
        >
          <FileText size={12} /> Factory PDF
        </a>
      </div>
    </div>
  )
}

// Builds a mailto: URL with subject + body pre-filled. Body includes a
// direct link to the PDF endpoint as a fallback for users who don't
// notice the manual-attach instruction. Encoding via encodeURIComponent
// per RFC 6068 — whitespace, line breaks, and special chars all valid.
function buildSupplierMailto(args: {
  to: string
  supplierName: string | null
  poNumber: string
  itemCount: number
  totalUnits: number
  pdfUrl: string
}): string {
  const subject = `Purchase Order ${args.poNumber}`
  const greeting = args.supplierName ? `Hi ${args.supplierName},` : 'Hello,'
  const body = [
    greeting,
    '',
    `Please find attached our purchase order ${args.poNumber} (${args.itemCount} line item${args.itemCount === 1 ? '' : 's'}, ${args.totalUnits} units total).`,
    '',
    `If the PDF didn't attach, you can also download it here:`,
    args.pdfUrl,
    '',
    'Please confirm receipt and the expected delivery date at your earliest convenience.',
    '',
    'Thank you,',
  ].join('\r\n')
  return (
    `mailto:${encodeURIComponent(args.to)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  )
}
