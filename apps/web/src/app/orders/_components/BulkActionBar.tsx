'use client'

/**
 * O.8e — extracted from OrdersWorkspace.tsx. Sticky toolbar that
 * appears when one or more orders is selected on the Grid lens.
 *
 * Live-scope actions:
 *   • Create shipments (POST /api/fulfillment/shipments/bulk-create)
 *   • Mark shipped (POST /api/orders/bulk-mark-shipped)
 *   • Request reviews (POST /api/orders/bulk-request-reviews)
 *   • Delete → recycle bin (POST /api/orders/bulk-soft-delete)
 *
 * Bin-scope actions (showDeleted=true):
 *   • Restore (POST /api/orders/bulk-restore)
 *   • Permanently delete (POST /api/orders/bulk-hard-delete) — guarded
 *     by a confirm modal that lists channel-synced rows.
 */

import { useState } from 'react'
import { FileText, Package, Printer, Star, Truck, X, Trash2, Undo2, AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { IconButton } from '@/components/ui/IconButton'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface OrderLite {
  id: string
  channel: string
  channelOrderId?: string | null
}

interface BulkActionBarProps {
  selectedIds: string[]
  /** When true, the orders are in the recycle bin — swap action set. */
  showDeleted: boolean
  /** Current page rows; used to detect channel-synced ids without an extra fetch. */
  orders: OrderLite[]
  onClear: () => void
  onComplete: () => void
}

export function BulkActionBar({
  selectedIds,
  showDeleted,
  orders,
  onClear,
  onComplete,
}: BulkActionBarProps) {
  const { t } = useTranslations()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmHardDelete, setConfirmHardDelete] = useState(false)

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true)
    setStatus(label)
    try {
      const res = await fn()
      if (typeof res === 'string') setStatus(res)
      else setStatus('Done')
      onComplete()
      setTimeout(() => setStatus(null), 2500)
    } catch (e: any) {
      setStatus(`Error: ${e.message ?? 'failed'}`)
      setTimeout(() => setStatus(null), 4000)
    } finally {
      setBusy(false)
    }
  }

  const createShipments = () =>
    run(t('orders.bulk.creatingShipments'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/shipments/bulk-create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderIds: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      return `Created ${data.created}, ${data.errors?.length ?? 0} errors`
    })

  const markShipped = () =>
    run(t('orders.bulk.markingShipped'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/bulk-mark-shipped`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderIds: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      return `Updated ${data.updated}`
    })

  // RV.4.4 — bulk action drill-down. Capture per-order errors[] so the
  // outcome modal can show which orders succeeded vs failed vs skipped.
  const [bulkReviewResult, setBulkReviewResult] = useState<{
    sent: number; skipped: number; failed: number
    errors: Array<{ orderId: string; reason: string }>
  } | null>(null)

  const requestReviews = () =>
    run(t('orders.bulk.requestingReviews'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/bulk-request-reviews`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderIds: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // Open the drill-down modal whenever ANYTHING was skipped or failed
      // (aggregate-only summary hides which orders need attention).
      if ((data.skipped ?? 0) > 0 || (data.failed ?? 0) > 0) {
        setBulkReviewResult({
          sent: data.sent ?? 0,
          skipped: data.skipped ?? 0,
          failed: data.failed ?? 0,
          errors: Array.isArray(data.errors) ? data.errors : [],
        })
      }
      return `Sent ${data.sent}, skipped ${data.skipped}, failed ${data.failed}`
    })

  // OX.5 — open a single browser tab containing N packing slips
  // concatenated with page-break-after; operator prints to PDF via the
  // browser dialog (no PDF library dep, same pattern as the per-order
  // packing-slip endpoint).
  const printPackingSlips = () => {
    const url = `${getBackendUrl()}/api/orders/bulk-packing-slips.html?ids=${selectedIds.join(',')}`
    const w = window.open(url, '_blank', 'noopener')
    if (!w) {
      setStatus('Allow popups to print packing slips')
      setTimeout(() => setStatus(null), 4000)
    }
  }

  // OX.5 — bulk-issue fiscal invoices (idempotent per order).
  const issueInvoices = () =>
    run('Issuing invoices…', async () => {
      const res = await fetch(`${getBackendUrl()}/api/orders/bulk-issue-invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: selectedIds }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const parts = [`+${data.newlyIssued} issued`]
      if (data.alreadyIssued) parts.push(`${data.alreadyIssued} already issued`)
      if (data.failed) parts.push(`${data.failed} failed`)
      return parts.join(' · ')
    })

  const softDelete = () =>
    run(t('orders.bulk.movingToBin'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/bulk-soft-delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      return t('orders.bulk.movedToBin', { n: data.changed })
    })

  const restore = () =>
    run(t('orders.bulk.restoring'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/bulk-restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      return t('orders.bulk.restored', { n: data.changed })
    })

  const hardDelete = () =>
    run(t('orders.bulk.permanentlyDeleting'), async () => {
      const res = await fetch(
        `${getBackendUrl()}/api/orders/bulk-hard-delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setConfirmHardDelete(false)
      return t('orders.bulk.permanentlyDeleted', { n: data.purged })
    })

  // Channel-synced rows in the current selection (used by the confirm
  // modal to warn the operator that those orders' source-of-truth lives
  // on Amazon/eBay/Shopify and won't be touched by this delete).
  const channelSynced = orders
    .filter((o) => selectedIds.includes(o.id) && !!o.channelOrderId)
    .map((o) => ({ id: o.id, channel: o.channel, channelOrderId: o.channelOrderId! }))

  return (
    <>
      <div className="sticky top-2 z-20">
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-slate-700">
              {t('orders.bulk.selected', { n: selectedIds.length })}
            </span>
            <div className="h-4 w-px bg-slate-200" />

            {showDeleted ? (
              <>
                <button
                  onClick={restore}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                >
                  <Undo2 size={12} /> {t('orders.bulk.restore')}
                </button>
                <button
                  onClick={() => setConfirmHardDelete(true)}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 disabled:opacity-50 inline-flex items-center gap-1.5 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                >
                  <Trash2 size={12} /> {t('orders.bulk.permanentlyDelete')}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={printPackingSlips}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-default rounded hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700"
                >
                  <Printer size={12} /> Print packing slips
                </button>
                <button
                  onClick={issueInvoices}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-violet-50 text-violet-700 border border-violet-200 rounded hover:bg-violet-100 disabled:opacity-50 inline-flex items-center gap-1.5 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800"
                >
                  <FileText size={12} /> Issue invoices
                </button>
                <button
                  onClick={createShipments}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Truck size={12} /> {t('orders.bulk.createShipments')}
                </button>
                <button
                  onClick={markShipped}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Package size={12} /> {t('orders.bulk.markShipped')}
                </button>
                <button
                  onClick={requestReviews}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Star size={12} /> {t('orders.bulk.requestReviews')}
                </button>
                <button
                  onClick={softDelete}
                  disabled={busy}
                  className="h-7 px-3 text-base bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 disabled:opacity-50 inline-flex items-center gap-1.5 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                >
                  <Trash2 size={12} /> {t('orders.bulk.delete')}
                </button>
              </>
            )}

            {status && (
              <span className="text-sm text-slate-500 ml-2">{status}</span>
            )}
            <IconButton
              aria-label="Clear selection"
              onClick={onClear}
              disabled={busy}
              className="ml-auto"
            >
              <X size={14} />
            </IconButton>
          </div>
        </Card>
      </div>

      {confirmHardDelete && (
        <div
          className="fixed inset-0 z-[1000] bg-slate-900/40 flex items-center justify-center p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmHardDelete(false) }}
        >
          <div
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-xl p-5"
            role="dialog"
            aria-label={t('orders.bulk.confirmHardDelete.title')}
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 shrink-0 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center">
                <AlertTriangle size={18} className="text-rose-600 dark:text-rose-400" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {t('orders.bulk.confirmHardDelete.title')}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {t('orders.bulk.confirmHardDelete.body', { n: selectedIds.length })}
                </p>
                {channelSynced.length > 0 && (
                  <div className="mt-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {t('orders.bulk.confirmHardDelete.channelWarningTitle', { n: channelSynced.length })}
                    </p>
                    <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                      {t('orders.bulk.confirmHardDelete.channelWarningBody')}
                    </p>
                    <ul className="mt-1.5 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                      {channelSynced.slice(0, 5).map((o) => (
                        <li key={o.id}>
                          <span className="font-mono">{o.channel}</span> · {o.channelOrderId}
                        </li>
                      ))}
                      {channelSynced.length > 5 && (
                        <li className="italic">… +{channelSynced.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmHardDelete(false)}
                disabled={busy}
                className="h-8 px-3 text-sm border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={hardDelete}
                disabled={busy}
                className="h-8 px-3 text-sm bg-rose-600 text-white border border-rose-600 rounded hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 size={12} /> {t('orders.bulk.confirmHardDelete.confirm', { n: selectedIds.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RV.4.4 — bulk review-request drill-down modal */}
      {bulkReviewResult && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setBulkReviewResult(null)}>
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-lg shadow-2xl flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-default dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Bulk review request — outcome
              </h3>
              <button onClick={() => setBulkReviewResult(null)} aria-label="Close" className="text-tertiary hover:text-slate-600">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-3 border-b border-default dark:border-slate-800 grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Sent</div>
                <div className="text-lg font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums">{bulkReviewResult.sent}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Skipped</div>
                <div className="text-lg font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{bulkReviewResult.skipped}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Failed</div>
                <div className="text-lg font-semibold text-rose-700 dark:text-rose-300 tabular-nums">{bulkReviewResult.failed}</div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {bulkReviewResult.errors.length === 0 ? (
                <p className="text-xs text-slate-500">No per-order details (all sent successfully).</p>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-500">{bulkReviewResult.errors.length} order{bulkReviewResult.errors.length !== 1 ? 's' : ''} need attention:</p>
                    <button
                      onClick={() => {
                        const csv = 'orderId,reason\n' + bulkReviewResult.errors.map(e => `${e.orderId},"${e.reason.replace(/"/g, '""')}"`).join('\n')
                        navigator.clipboard.writeText(csv)
                        setStatus('Copied CSV')
                        setTimeout(() => setStatus(null), 2000)
                      }}
                      className="text-[11px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Copy CSV
                    </button>
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-default dark:border-slate-800">
                      <tr><th className="py-1">Order ID</th><th className="py-1">Reason</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {bulkReviewResult.errors.map((e, i) => (
                        <tr key={i}>
                          <td className="py-1.5 font-mono text-slate-600 dark:text-slate-400">{e.orderId}</td>
                          <td className="py-1.5 text-slate-700 dark:text-slate-300">{e.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-default dark:border-slate-800 flex justify-end">
              <button onClick={() => setBulkReviewResult(null)} className="h-8 px-3 text-sm rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
