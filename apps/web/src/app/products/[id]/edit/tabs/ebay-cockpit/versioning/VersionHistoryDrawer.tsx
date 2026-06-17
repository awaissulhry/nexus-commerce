'use client'

// EC.10 — VersionHistoryDrawer
//
// Slide-in drawer listing the last 10 snapshots of this listing.
// Each row shows the timestamp, reason (auto / manual / pre-publish
// / pre-restore), a short summary of what was in the snapshot
// (category, aspect count, price), and a Restore button.
//
// Restore is non-destructive: the API snapshots CURRENT state first
// under reason="pre-restore" so undo is one click. The drawer
// re-fetches via router.refresh() afterwards.

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, History, RotateCcw, Camera, Loader2, Sparkles, FileClock, ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface SnapshotEntry {
  id: string
  ts: string
  reason: string
  snapshot: {
    platformAttributes: Record<string, unknown>
    priceOverride: number | null
    quantity: number | null
  }
}

interface Props {
  productId: string
  marketplace: string
  marketName: string
  currency: string
  history: SnapshotEntry[]
  open: boolean
  onClose: () => void
}

const REASON_ICON: Record<string, { Icon: React.ComponentType<{ className?: string }>; tone: string; label: string }> = {
  manual:      { Icon: Camera,      tone: 'text-blue-500',    label: 'Manual snapshot' },
  auto:        { Icon: FileClock,   tone: 'text-tertiary',   label: 'Auto snapshot' },
  'pre-publish': { Icon: Sparkles,  tone: 'text-emerald-500', label: 'Pre-publish snapshot' },
  'pre-restore': { Icon: ShieldAlert, tone: 'text-amber-500', label: 'Pre-restore snapshot' },
}

function relativeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function summarise(entry: SnapshotEntry, currency: string): string[] {
  const out: string[] = []
  const p = entry.snapshot.platformAttributes
  const catName = (p.categoryName as string | undefined) ?? null
  const catId = (p.categoryId as string | undefined) ?? null
  if (catName || catId) out.push(`Category: ${catName ?? catId}`)
  const items = p.itemSpecifics
  if (items && typeof items === 'object') {
    const count = Object.keys(items as Record<string, unknown>).length
    if (count > 0) out.push(`${count} aspect${count === 1 ? '' : 's'}`)
  }
  if (entry.snapshot.priceOverride != null) {
    out.push(`${currency} ${entry.snapshot.priceOverride.toFixed(2)}`)
  }
  if (entry.snapshot.quantity != null) {
    out.push(`qty ${entry.snapshot.quantity}`)
  }
  const axes = (p._variationAxes as string[] | undefined) ?? []
  if (axes.length > 0) out.push(`axes: ${axes.join('×')}`)
  if (p.bestOfferEnabled === true) out.push('Best Offer on')
  return out
}

export default function VersionHistoryDrawer({
  productId,
  marketplace,
  marketName,
  currency,
  history,
  open,
  onClose,
}: Props) {
  const router = useRouter()
  const [restoring, setRestoring] = useState<string | null>(null)
  const [snapshotting, setSnapshotting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSnapshotNow = useCallback(async () => {
    if (snapshotting) return
    setSnapshotting(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, marketplace, reason: 'manual' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSnapshotting(false)
    }
  }, [snapshotting, productId, marketplace, router])

  const handleRestore = useCallback(async (snapshotId: string) => {
    if (restoring) return
    setRestoring(snapshotId)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/snapshot/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, marketplace, snapshotId }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      router.refresh()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(null)
    }
  }, [restoring, productId, marketplace, router, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-drawer-title"
        className="w-full max-w-md bg-white dark:bg-slate-900 border-l border-default dark:border-slate-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="version-drawer-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <History className="w-4 h-4 text-blue-500" />
              Version history — {marketName}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {history.length === 0 ? 'No snapshots yet' : `${history.length} snapshot${history.length === 1 ? '' : 's'} · oldest first dropped after 10`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Snapshot now */}
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSnapshotNow}
            disabled={snapshotting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {snapshotting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
            {snapshotting ? 'Snapshotting…' : 'Snapshot now'}
          </button>
          <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
            Captures the current listing state so you can roll back later.
          </span>
        </div>

        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
            {error}
          </div>
        )}

        {/* History list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {history.length === 0 && (
            <div className="text-xs text-tertiary italic text-center py-8">
              No snapshots taken yet. Click "Snapshot now" to capture the
              current state — auto-snapshots will be taken before any
              publish operation.
            </div>
          )}
          {history.map((entry) => {
            const meta = REASON_ICON[entry.reason] ?? REASON_ICON.manual!
            const Icon = meta.Icon
            const summary = summarise(entry, currency)
            const isRestoring = restoring === entry.id
            return (
              <div
                key={entry.id}
                className="rounded border border-default dark:border-slate-800 p-3 space-y-2"
              >
                <div className="flex items-start gap-2">
                  <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', meta.tone)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      {meta.label}
                    </div>
                    <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {relativeAgo(entry.ts)} · <span className="font-mono">{new Date(entry.ts).toLocaleString()}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestore(entry.id)}
                    disabled={isRestoring || restoring !== null}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    {isRestoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    Restore
                  </button>
                </div>
                {summary.length > 0 && (
                  <div className="flex flex-wrap gap-1 text-[10.5px]">
                    {summary.map((s, i) => (
                      <span key={i} className="inline-flex px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="px-4 py-2 border-t border-subtle dark:border-slate-800 text-[10.5px] text-tertiary italic">
          Restore is non-destructive — your current state is snapshotted
          first as "Pre-restore" so undo is one click.
        </div>
      </aside>
    </div>
  )
}
