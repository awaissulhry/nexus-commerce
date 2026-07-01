'use client'

/**
 * Phase 6 Task 4 — Delta-preview modal.
 *
 * Read-only preview of what the next FBM push would set for a single
 * channel×marketplace listing. Fetches
 *   GET /api/inventory-sync/control-tower/:sku/delta?channel=&marketplace=
 * and renders:
 *   - FBM: current published qty → target qty, a "would clamp" warning,
 *     plus warehouseAvailable + stockBuffer detail.
 *   - FBA: an "Amazon-managed (FBA)" note (no FBM delta applies).
 *
 * No writes — this endpoint never pushes, enqueues, or mutates stock.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, Info, Loader2, PackageCheck } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────

interface DeltaFbm {
  sku: string
  channel: string
  marketplace: string | null
  currentPublishedQty: number | null
  targetQty: number
  wouldClamp: boolean
  warehouseAvailable: number
  stockBuffer: number
  fbaManaged: false
}

interface DeltaFba {
  sku: string
  channel: string
  marketplace: string | null
  currentPublishedQty: number | null
  fbaManaged: true
  note?: string
}

type DeltaResponse = DeltaFbm | DeltaFba

export interface DeltaPreviewTarget {
  sku: string
  channel: string
  marketplace: string | null
}

// ── Component ───────────────────────────────────────────────────────────────

export function DeltaPreviewModal({
  target,
  onClose,
}: {
  target: DeltaPreviewTarget
  onClose: () => void
}) {
  const { sku, channel, marketplace } = target
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DeltaResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      p.set('channel', channel)
      if (marketplace) p.set('marketplace', marketplace)
      const res = await fetch(
        `${getBackendUrl()}/api/inventory-sync/control-tower/${encodeURIComponent(sku)}/delta?${p}`,
      )
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const body = await res.json()
          if (body?.error) msg = body.error
        } catch {}
        throw new Error(msg)
      }
      setData((await res.json()) as DeltaResponse)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load delta')
    } finally {
      setLoading(false)
    }
  }, [sku, channel, marketplace])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Sync delta preview"
      description={
        <span className="font-mono">
          {sku} · {channel}
          {marketplace ? ` · ${marketplace}` : ''}
        </span>
      }
    >
      <ModalBody className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-tertiary" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-3 py-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-red-700 dark:text-red-300 mb-1">
              <AlertTriangle className="w-4 h-4" />
              Could not load delta
            </div>
            <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
          </div>
        ) : data?.fbaManaged ? (
          // ── FBA: Amazon-managed ──────────────────────────────────────────
          <div className="space-y-4">
            <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/20 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-300 mb-1">
                <PackageCheck className="w-4 h-4" />
                Amazon-managed (FBA)
              </div>
              <p className="text-xs text-orange-700/90 dark:text-orange-300/90">
                {data.note ??
                  'Published quantity is owned by Amazon FBA — no FBM delta applies to this listing.'}
              </p>
            </div>
            <DetailRow label="Current published qty" value={fmtQty(data.currentPublishedQty)} />
          </div>
        ) : data ? (
          // ── FBM: current → target ────────────────────────────────────────
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-4 py-2">
              <QtyBlock label="Current" value={data.currentPublishedQty} />
              <ArrowRight className="w-5 h-5 text-tertiary flex-shrink-0" />
              <QtyBlock
                label="Target"
                value={data.targetQty}
                tone={data.wouldClamp ? 'warning' : 'ok'}
              />
            </div>

            {data.wouldClamp && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-300 mb-0.5">
                  <AlertTriangle className="w-4 h-4" />
                  Would clamp
                </div>
                <p className="text-xs text-amber-700/90 dark:text-amber-300/90">
                  Publishing now would reduce the listed quantity from{' '}
                  <span className="font-semibold tabular-nums">{fmtQty(data.currentPublishedQty)}</span> down to{' '}
                  <span className="font-semibold tabular-nums">{data.targetQty}</span> to match available stock.
                </p>
              </div>
            )}

            <div className="rounded-lg border border-default dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
              <DetailRow label="Warehouse available" value={String(data.warehouseAvailable)} />
              <DetailRow label="Stock buffer" value={String(data.stockBuffer)} />
              <DetailRow
                label="Target = available − buffer"
                value={String(data.targetQty)}
                muted
              />
            </div>

            <div className="flex items-start gap-1.5 text-[11px] text-tertiary dark:text-slate-500">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
              <span>Read-only preview — nothing is pushed or changed. It reflects what the next FBM sync would set.</span>
            </div>
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function fmtQty(q: number | null): string {
  return q == null ? '—' : String(q)
}

function QtyBlock({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number | null
  tone?: 'neutral' | 'ok' | 'warning'
}) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-tertiary dark:text-slate-500 mb-0.5">
        {label}
      </div>
      <div
        className={cn(
          'text-3xl font-bold tabular-nums',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'warning' && 'text-amber-600 dark:text-amber-400',
          tone === 'neutral' && 'text-slate-900 dark:text-slate-100',
        )}
      >
        {fmtQty(value)}
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  muted,
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className={cn('text-xs', muted ? 'text-tertiary dark:text-slate-500' : 'text-slate-600 dark:text-slate-400')}>
        {label}
      </span>
      <span className={cn('text-sm font-semibold tabular-nums', muted ? 'text-slate-600 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100')}>
        {value}
      </span>
    </div>
  )
}
