'use client'

// PO-Plus.3 — Quick-receive modal for the PO detail page.
//
// Operator clicks "Create receipt" on a SUBMITTED+ PO; the modal
// shows per-line open qty (ordered − received) pre-filled, plus
// carrier/tracking/arrival/notes fields. Submit creates the
// InboundShipment AND immediately applies the receive in one shot
// via the new /quick-receive endpoint.

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PackageCheck,
  Truck,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DateField } from '@/design-system/components/DateField'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { formatCurrency } from './po-lens'

interface PoLine {
  id: string
  sku: string
  quantityOrdered: number
  quantityReceived: number
  unitCostCents: number
  note: string | null
}

interface DraftRow {
  purchaseOrderItemId: string
  sku: string
  openQty: number
  unitCostCents: number
  note: string | null
  quantityReceived: string // form input — parsed at submit
}

export function QuickReceiveModal({
  poId,
  poNumber,
  poCurrency,
  items,
  onClose,
  onReceived,
}: {
  poId: string
  poNumber: string
  poCurrency: string
  items: PoLine[]
  onClose: () => void
  onReceived: () => void | Promise<void>
}) {
  // Seed rows with open qty as the default received qty so the
  // operator just hits Submit if they got everything.
  const [rows, setRows] = useState<DraftRow[]>(() =>
    items
      .map((it) => {
        const openQty = Math.max(0, it.quantityOrdered - it.quantityReceived)
        return {
          purchaseOrderItemId: it.id,
          sku: it.sku,
          openQty,
          unitCostCents: it.unitCostCents,
          note: it.note,
          quantityReceived: openQty > 0 ? String(openQty) : '',
        }
      })
      .filter((r) => r.openQty > 0),
  )

  const [reference, setReference] = useState('')
  const [carrierCode, setCarrierCode] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [arrivedAt, setArrivedAt] = useState(() =>
    new Date().toISOString().slice(0, 10),
  )
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc closes.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [submitting, onClose])

  const updateRow = useCallback((poiId: string, qty: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.purchaseOrderItemId === poiId ? { ...r, quantityReceived: qty } : r,
      ),
    )
  }, [])

  const fillAllOpen = useCallback(() => {
    setRows((prev) =>
      prev.map((r) => ({ ...r, quantityReceived: String(r.openQty) })),
    )
  }, [])

  const clearAll = useCallback(() => {
    setRows((prev) => prev.map((r) => ({ ...r, quantityReceived: '' })))
  }, [])

  const totalUnitsReceiving = rows.reduce(
    (s, r) => s + (parseInt(r.quantityReceived, 10) || 0),
    0,
  )
  const totalValueCents = rows.reduce((s, r) => {
    const q = parseInt(r.quantityReceived, 10) || 0
    return s + q * r.unitCostCents
  }, 0)

  const submit = async () => {
    setError(null)
    const payloadItems = rows
      .map((r) => ({
        purchaseOrderItemId: r.purchaseOrderItemId,
        quantityReceived: parseInt(r.quantityReceived, 10) || 0,
      }))
      .filter((r) => r.quantityReceived > 0)

    if (payloadItems.length === 0) {
      setError('Enter a received quantity on at least one line.')
      return
    }
    // Sanity guard — refuse over-receipts unless operator explicitly
    // typed a value greater than openQty (which we allow but flag in
    // the UI). The backend's syncPoState will still mark it as PARTIAL
    // / RECEIVED correctly; just warn here.

    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/quick-receive`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: payloadItems,
            reference: reference.trim() || undefined,
            carrierCode: carrierCode.trim() || undefined,
            trackingNumber: trackingNumber.trim() || undefined,
            arrivedAt: arrivedAt || undefined,
            notes: notes.trim() || undefined,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      await onReceived()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Quick-receive ${poNumber}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-default dark:border-slate-700 px-5 py-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <PackageCheck className="w-4 h-4" />
            Create receipt — {poNumber}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {rows.length === 0 ? (
            <div className="text-base text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-default dark:border-slate-700 rounded p-4">
              All lines on this PO are already fully received. There's nothing left to receive.
            </div>
          ) : (
            <>
              {/* Shipment-level fields */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Arrived">
                  <DateField
                    value={arrivedAt}
                    onChange={(v) => setArrivedAt(v)}
                    disabled={submitting}
                    ariaLabel="Arrived"
                    className="w-full"
                  />
                </Field>
                <Field label="Reference">
                  <input
                    type="text"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder={`Receipt for ${poNumber}`}
                    disabled={submitting}
                    className="w-full h-9 px-2 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                </Field>
                <Field label="Carrier">
                  <div className="relative">
                    <Truck
                      size={12}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary dark:text-slate-500 pointer-events-none"
                    />
                    <input
                      type="text"
                      value={carrierCode}
                      onChange={(e) => setCarrierCode(e.target.value.toUpperCase())}
                      placeholder="BRT, POSTE, GLS, DHL…"
                      maxLength={20}
                      disabled={submitting}
                      className="w-full h-9 pl-7 pr-2 text-base font-mono uppercase border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </Field>
                <Field label="Tracking number">
                  <input
                    type="text"
                    value={trackingNumber}
                    onChange={(e) => setTrackingNumber(e.target.value)}
                    placeholder="optional"
                    disabled={submitting}
                    className="w-full h-9 px-2 text-base font-mono border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                </Field>
              </div>

              {/* Lines */}
              <div className="border border-default dark:border-slate-700 rounded overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border-b border-default dark:border-slate-700 flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  <span>Lines</span>
                  <div className="inline-flex items-center gap-2 normal-case font-normal">
                    <button
                      type="button"
                      onClick={fillAllOpen}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Fill all (open)
                    </button>
                    <span className="text-slate-300 dark:text-slate-600">|</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-sm text-slate-500 dark:text-slate-400 hover:underline"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
                <table className="w-full text-base">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-default dark:border-slate-700">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">SKU</th>
                      <th className="text-right font-medium px-3 py-1.5 w-24">Open</th>
                      <th className="text-right font-medium px-3 py-1.5 w-28">Receive now</th>
                      <th className="text-right font-medium px-3 py-1.5 w-28">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const qty = parseInt(r.quantityReceived, 10) || 0
                      const overReceipt = qty > r.openQty
                      const subtotal = qty * r.unitCostCents
                      return (
                        <tr
                          key={r.purchaseOrderItemId}
                          className="border-b border-subtle dark:border-slate-800 last:border-0 align-top"
                        >
                          <td className="px-3 py-2 font-mono text-sm">
                            {r.sku}
                            {r.note && (
                              <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-0.5 font-sans">
                                {r.note}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                            {r.openQty}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={r.quantityReceived}
                              onChange={(e) =>
                                updateRow(r.purchaseOrderItemId, e.target.value)
                              }
                              disabled={submitting}
                              className={cn(
                                'w-full h-8 px-2 text-base text-right tabular-nums border rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100',
                                overReceipt
                                  ? 'border-red-300 dark:border-red-700 bg-red-50/30 dark:bg-red-950/20'
                                  : 'border-default dark:border-slate-700',
                              )}
                            />
                            {overReceipt && (
                              <div className="text-xs text-red-700 dark:text-red-300 text-right mt-0.5">
                                +{qty - r.openQty} over
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                            {formatCurrency(subtotal, poCurrency)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 dark:bg-slate-800 border-t border-default dark:border-slate-700">
                    <tr>
                      <td colSpan={2} className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                        {totalUnitsReceiving} u
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                        {formatCurrency(totalValueCents, poCurrency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Notes */}
              <Field label="Receive notes (optional)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Packaging damage, supplier short-shipped X, lot codes captured, …"
                  disabled={submitting}
                  className="w-full px-2 py-1.5 text-base border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </Field>

              {error && (
                <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-default dark:border-slate-700 px-5 py-3 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {rows.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={submitting || totalUnitsReceiving === 0}
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              Receive {totalUnitsReceiving} unit{totalUnitsReceiving === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
        {label}
      </div>
      {children}
    </div>
  )
}
