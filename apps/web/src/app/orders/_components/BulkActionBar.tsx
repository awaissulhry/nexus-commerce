'use client'

/**
 * O.8e — extracted from OrdersWorkspace.tsx. Sticky toolbar that
 * appears when one or more orders is selected on the Grid lens.
 *
 * Three wired actions today:
 *   • Create shipments (POST /api/fulfillment/shipments/bulk-create)
 *   • Mark shipped (POST /api/orders/bulk-mark-shipped)
 *   • Request reviews (POST /api/orders/bulk-request-reviews)
 *
 * Inline status feedback: success message renders for ~2.5s,
 * errors for ~4s. The export / print / hold / cancel / apply-rule
 * additions are P1 (later).
 */

import { useState } from 'react'
import { Package, Star, Truck, X } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { IconButton } from '@/components/ui/IconButton'
import { getBackendUrl } from '@/lib/backend-url'

interface BulkActionBarProps {
  selectedIds: string[]
  onClear: () => void
  onComplete: () => void
}

export function BulkActionBar({
  selectedIds,
  onClear,
  onComplete,
}: BulkActionBarProps) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

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
    run('Creating shipments…', async () => {
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
    run('Marking shipped…', async () => {
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

  const requestReviews = () =>
    run('Requesting reviews…', async () => {
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
      return `Sent ${data.sent}, skipped ${data.skipped}, failed ${data.failed}`
    })

  return (
    <div className="sticky top-2 z-20">
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-slate-700">
            {selectedIds.length} selected
          </span>
          <div className="h-4 w-px bg-slate-200" />
          <button
            onClick={createShipments}
            disabled={busy}
            className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Truck size={12} /> Create shipments
          </button>
          <button
            onClick={markShipped}
            disabled={busy}
            className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Package size={12} /> Mark shipped
          </button>
          <button
            onClick={requestReviews}
            disabled={busy}
            className="h-7 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Star size={12} /> Request reviews
          </button>
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
  )
}
