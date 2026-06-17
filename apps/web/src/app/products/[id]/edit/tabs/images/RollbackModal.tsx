'use client'

// PB.9 — Rollback-to-last-published confirmation modal.
//
// Reads the localStorage snapshot for (productId, channel,
// marketplace), shows a diff against current ListingImage state,
// and on confirm builds pending upserts that restore the snapshot
// URLs. After the modal closes the operator clicks Save (or the
// combo Save & publish) to commit + push back to the channel.
//
// Behavior:
//   - When no snapshot exists → modal shows "no captured state"
//     and offers only Close.
//   - When current state already matches → "Nothing to revert."
//   - Otherwise renders a list of per-row diff entries. The
//     'restore' rows show a thumb of current AND snapshot URL
//     side-by-side. 'recreate' rows show just the snapshot URL
//     with a note. 'extra' rows are informational (won't be
//     touched).

import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Loader2, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import {
  buildRollbackDiff,
  clearSnapshot,
  readSnapshot,
  type DiffEntry,
  type Snapshot,
  type SnapshotChannel,
} from './publishSnapshotStorage'
import type { ListingImage, PendingUpsert } from './types'

interface Props {
  open: boolean
  productId: string
  channel: SnapshotChannel
  marketplace?: string | null
  listingImages: ListingImage[]
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  onToast: (msg: string) => void
  onClose: () => void
}

export default function RollbackModal({
  open,
  productId,
  channel,
  marketplace = null,
  listingImages,
  addPendingUpsert,
  onToast,
  onClose,
}: Props) {
  const [applying, setApplying] = useState(false)

  const snapshot = useMemo<Snapshot | null>(
    () => (open ? readSnapshot({ productId, channel, marketplace }) : null),
    [open, productId, channel, marketplace],
  )
  const diff = useMemo<DiffEntry[]>(
    () => (snapshot ? buildRollbackDiff({ snapshot, listingImages }) : []),
    [snapshot, listingImages],
  )

  if (!open) return null

  const channelLabel = channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : 'Shopify'
  const restoreEntries = diff.filter((d) => d.kind === 'restore' || d.kind === 'recreate')
  const extraEntries = diff.filter((d) => d.kind === 'extra')

  async function applyRollback() {
    if (!snapshot || restoreEntries.length === 0) return
    setApplying(true)
    try {
      let queued = 0
      for (const entry of restoreEntries) {
        if (entry.kind === 'restore' && entry.currentRow && entry.snapshotRow) {
          // Update existing row → pending upsert with id set.
          addPendingUpsert({
            id: entry.currentRow.id,
            scope: entry.currentRow.scope,
            platform: entry.currentRow.platform,
            marketplace: entry.currentRow.marketplace,
            amazonSlot: entry.currentRow.amazonSlot,
            variantGroupKey: entry.currentRow.variantGroupKey,
            variantGroupValue: entry.currentRow.variantGroupValue,
            url: entry.snapshotRow.url,
            role: entry.currentRow.role,
            position: entry.currentRow.position,
          })
          queued++
        } else if (entry.kind === 'recreate' && entry.snapshotRow) {
          // Snapshot row no longer in DB — create as new pending
          // upsert. Scope inference: prefer the snapshot's marketplace
          // narrowing when present.
          addPendingUpsert({
            scope: marketplace ? 'MARKETPLACE' : 'PLATFORM',
            platform: channel,
            marketplace: marketplace ?? null,
            amazonSlot: entry.snapshotRow.amazonSlot,
            variantGroupKey: entry.snapshotRow.variantGroupKey,
            variantGroupValue: entry.snapshotRow.variantGroupValue,
            url: entry.snapshotRow.url,
            role: entry.snapshotRow.role,
            position: entry.snapshotRow.position,
          })
          queued++
        }
      }
      onToast(`Queued ${queued} change${queued === 1 ? '' : 's'} — Save to commit, then Publish to push.`)
      onClose()
    } finally {
      setApplying(false)
    }
  }

  function dropSnapshot() {
    clearSnapshot({ productId, channel, marketplace })
    onToast('Cleared captured snapshot for this channel.')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={applying ? undefined : onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-default dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Revert to last published — {channelLabel}{marketplace ? ` ${marketplace}` : ''}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Restores the image URLs that were in place at the last successful publish.
              You'll still need to Save + Publish afterwards to push them back to the channel.
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} disabled={applying} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!snapshot && (
            <div className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
              No captured state for {channelLabel}{marketplace ? ` ${marketplace}` : ''}.
              <br />
              Snapshots are captured automatically after each successful publish in this browser.
            </div>
          )}

          {snapshot && (
            <>
              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 mb-3">
                <span>
                  Captured <span className="font-mono text-slate-700 dark:text-slate-300">{elapsed(snapshot.capturedAt)}</span>
                </span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span>{snapshot.rows.length} row{snapshot.rows.length === 1 ? '' : 's'} in snapshot</span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span>{restoreEntries.length} would change</span>
                {extraEntries.length > 0 && (
                  <>
                    <span className="text-slate-300 dark:text-slate-700">·</span>
                    <span>{extraEntries.length} new (untouched)</span>
                  </>
                )}
              </div>

              {restoreEntries.length === 0 && (
                <div className="text-xs text-emerald-600 dark:text-emerald-400 py-6 text-center">
                  Nothing to revert — current state already matches the snapshot.
                </div>
              )}

              {restoreEntries.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
                    Will change
                  </div>
                  {restoreEntries.map((entry, idx) => (
                    <DiffRow key={`r-${idx}`} entry={entry} />
                  ))}
                </div>
              )}

              {extraEntries.length > 0 && (
                <div className="mt-4 space-y-2">
                  <div className="text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
                    Won't touch (added since publish)
                  </div>
                  {extraEntries.map((entry, idx) => (
                    <DiffRow key={`e-${idx}`} entry={entry} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-default dark:border-slate-700 flex items-center gap-2 bg-slate-50/50 dark:bg-slate-900/50">
          {snapshot && (
            <Button
              size="sm"
              variant="ghost"
              onClick={dropSnapshot}
              disabled={applying}
              className="text-rose-600 dark:text-rose-400"
              title="Discard the captured snapshot — rollback won't be available until next publish."
            >
              Clear snapshot
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!snapshot || restoreEntries.length === 0 || applying}
              onClick={() => void applyRollback()}
              className="gap-1.5"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              Queue {restoreEntries.length} restore{restoreEntries.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function elapsed(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  const tone = entry.kind === 'restore'
    ? 'border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20'
    : entry.kind === 'recreate'
      ? 'border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20'
      : 'border-default dark:border-slate-700 bg-white dark:bg-slate-900'

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2 rounded-lg border', tone)}>
      <div className="text-xs font-mono text-slate-700 dark:text-slate-300 min-w-[140px]">
        {entry.label}
      </div>
      {entry.kind === 'restore' && entry.currentRow && entry.snapshotRow && (
        <>
          <Thumb url={entry.currentRow.url} label="current" />
          <ArrowRight className="w-3.5 h-3.5 text-tertiary flex-shrink-0" />
          <Thumb url={entry.snapshotRow.url} label="snapshot" />
        </>
      )}
      {entry.kind === 'recreate' && entry.snapshotRow && (
        <>
          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            recreate
          </span>
          <Thumb url={entry.snapshotRow.url} label="snapshot" />
        </>
      )}
      {entry.kind === 'extra' && entry.currentRow && (
        <>
          <span className="text-[10px] text-slate-500">added since publish</span>
          <Thumb url={entry.currentRow.url} label="current" />
        </>
      )}
    </div>
  )
}

function Thumb({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
      <div className="w-10 h-10 rounded border border-default dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800">
        <img src={url} alt="" className="w-full h-full object-cover" />
      </div>
      <span className="text-[9px] text-tertiary uppercase tracking-wide">{label}</span>
    </div>
  )
}
