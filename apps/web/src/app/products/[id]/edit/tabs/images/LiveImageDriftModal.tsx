'use client'

// IE.5 — Live ↔ Nexus drift modal.
//
// Opens when the operator clicks a flagged thumb in the LiveChannelStrip.
// Renders both images side-by-side with metadata and offers two paths:
//   • Adopt into master — pulls the live URL into the master gallery as
//     a new ProductImage row (only when no Nexus row exists for this
//     slot; the "Nexus side" half is the empty state).
//   • Close — operator wants to keep the difference. The intended
//     "Republish to fix" CTA needs the per-slot publish endpoint to
//     accept an arbitrary master image, which lands in IE.5b.

import { X, AlertTriangle, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import type { ChannelLiveImage } from './types'

interface Props {
  open: boolean
  live: ChannelLiveImage | null
  nexusUrl: string | null
  onClose: () => void
  onAdoptToMaster?: (url: string) => void
  onRepublish?: () => void
}

export default function LiveImageDriftModal({
  open,
  live,
  nexusUrl,
  onClose,
  onAdoptToMaster,
  onRepublish,
}: Props) {
  if (!open || !live) return null
  const isOrphan = !nexusUrl
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-default dark:border-slate-700">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {isOrphan ? 'Live image not in Nexus' : 'Live image differs from Nexus'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {live.channel} · {live.marketplace ?? 'GLOBAL'} · slot {live.slot ?? '?'} · SKU {live.externalSku ?? '?'}
              </p>
            </div>
          </div>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Live on channel
            </p>
            <div className="aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden border border-amber-300 dark:border-amber-700">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={live.url} alt="" className="w-full h-full object-contain" />
            </div>
            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate" title={live.url}>
              {live.width && live.height ? `${live.width}×${live.height} · ` : ''}{live.url}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Nexus intent
            </p>
            <div className="aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden border border-default dark:border-slate-700">
              {nexusUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={nexusUrl} alt="" className="w-full h-full object-contain" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-tertiary gap-1 text-xs">
                  <Link2 className="w-5 h-5" />
                  <span>No matching ListingImage</span>
                </div>
              )}
            </div>
            {nexusUrl && (
              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate" title={nexusUrl}>
                {nexusUrl}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-subtle dark:border-slate-800">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">
            Close
          </Button>
          {isOrphan && onAdoptToMaster && (
            <Button
              size="sm"
              onClick={() => { onAdoptToMaster(live.url); onClose() }}
              className="text-xs gap-1.5"
            >
              <Link2 className="w-3 h-3" />
              Adopt into master
            </Button>
          )}
          {!isOrphan && onRepublish && (
            <Button
              size="sm"
              onClick={() => { onRepublish(); onClose() }}
              className="text-xs"
            >
              Republish to fix
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
