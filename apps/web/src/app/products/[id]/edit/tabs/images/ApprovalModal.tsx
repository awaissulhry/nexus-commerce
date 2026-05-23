'use client'

// PB.12 — Approval queue modal. Lists pending approval requests for
// this product; operator can Approve (fires the deferred publish) or
// Reject (drops the request with an optional reason in the toast).
//
// Browser-side queue — see approvalPrefs.ts. Multi-operator
// coordination needs a server-side ImagePublishApproval model
// (PB.12b queued).

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import {
  type PendingApproval,
  readPendingApprovals,
  removePendingApproval,
} from './approvalPrefs'
import type { PublishTarget } from './ImageActionBar'

interface Props {
  open: boolean
  productId: string
  /** Fires the actual publish for an approved target — reuses the
   *  same handlePublish the action bar's dropdown uses, so the
   *  capture + snapshot side-effects are identical to a normal
   *  publish. */
  onPublish: (target: PublishTarget) => Promise<void>
  onToast: (msg: string) => void
  onClose: () => void
  /** Bumped when the queue changes so the parent's "N awaiting
   *  approval" badge stays current. */
  onChanged?: () => void
}

function describeTarget(target: PublishTarget): string {
  if (target.channel === 'AMAZON') {
    return target.marketplace === 'ALL'
      ? 'All Amazon markets'
      : `Amazon ${target.marketplace}`
  }
  if (target.channel === 'EBAY') return 'eBay'
  return 'Shopify'
}

function elapsed(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function ApprovalModal({
  open,
  productId,
  onPublish,
  onToast,
  onClose,
  onChanged,
}: Props) {
  const [list, setList] = useState<PendingApproval[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  function refresh() {
    setList(readPendingApprovals(productId))
  }

  useEffect(() => {
    if (open) refresh()
  }, [open, productId])

  if (!open) return null

  async function approve(entry: PendingApproval) {
    setBusyId(entry.id)
    try {
      removePendingApproval(productId, entry.id)
      refresh()
      onChanged?.()
      await onPublish(entry.target)
    } finally {
      setBusyId(null)
    }
  }

  function reject(entry: PendingApproval) {
    removePendingApproval(productId, entry.id)
    refresh()
    onChanged?.()
    onToast(`Rejected ${describeTarget(entry.target)} publish.`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busyId ? undefined : onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Publishes awaiting approval
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Approval is required on this product. Each entry is a deferred publish — Approve to fire, Reject to drop.
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} disabled={!!busyId} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {list.length === 0 && (
            <div className="text-xs text-slate-400 italic py-6 text-center">
              No pending approvals. Publishes you trigger while "Require approval" is on will land here.
            </div>
          )}
          {list.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
                busyId === entry.id && 'opacity-50',
              )}
            >
              <Clock className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  {describeTarget(entry.target)}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                  requested {elapsed(entry.requestedAt)}
                  {entry.note && <span className="ml-2 italic text-slate-400">— {entry.note}</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => reject(entry)}
                disabled={busyId === entry.id}
                className="text-xs gap-1 text-rose-600 dark:text-rose-400"
              >
                <X className="w-3 h-3" />
                Reject
              </Button>
              <Button
                size="sm"
                onClick={() => void approve(entry)}
                disabled={busyId === entry.id}
                className="text-xs gap-1"
              >
                {busyId === entry.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                Approve
              </Button>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center bg-slate-50/50 dark:bg-slate-900/50">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Browser-side queue. Multi-operator routing comes in PB.12b.
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={!!busyId} className="ml-auto">
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
