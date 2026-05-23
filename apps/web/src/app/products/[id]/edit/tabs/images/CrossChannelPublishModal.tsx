'use client'

// PB.5 — Cross-channel pre-publish summary modal.
//
// One modal to plan a publish across Amazon (all 5 markets), eBay,
// and Shopify in one shot. Each channel renders as a card with a
// checkbox + coverage stats + validation status. Confirm fires the
// selected channels sequentially via the parent's onPublishChannel
// delegate (which reuses the same per-channel publish handler the
// dropdown + per-panel buttons already use), reporting progress.
//
// What this is NOT:
//   - It doesn't replace the per-channel preview modals (PB.3b);
//     those still own per-variant detail tables.
//   - It doesn't do server-side cross-channel validation; we rely
//     on each channel's existing gate (IA.4 for Amazon, PB.3a
//     useChannelValidation() for eBay/Shopify).

import { useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Loader2, ShoppingBag,
  Store, X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import type { PublishTarget } from './ImageActionBar'
import { useChannelValidation } from './ChannelValidationBanner'
import { findStaleListingImages } from './ChannelStaleBanner'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary } from './types'

type ChannelKey = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface Props {
  open: boolean
  /** Reserved for future per-channel server fetches (validation
   *  details, server-side preview, etc.). Not used yet. */
  productId: string
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  pendingUpserts: Map<string, PendingUpsert>
  pendingDeletes: Set<string>
  variants: VariantSummary[]
  /** Same — held in case the channel cards grow per-axis detail. */
  activeAxis: string
  onPublishChannel: (target: PublishTarget) => Promise<void>
  onClose: () => void
}

interface ProgressEntry {
  channel: ChannelKey
  status: 'pending' | 'in-progress' | 'done' | 'error'
  message?: string
}

export default function CrossChannelPublishModal({
  open,
  productId: _productId,
  masterImages,
  listingImages,
  pendingUpserts,
  pendingDeletes,
  variants,
  activeAxis: _activeAxis,
  onPublishChannel,
  onClose,
}: Props) {
  // Per-channel slice computations stay in render (cheap) — they
  // already do via the per-panel hooks, this is just a different
  // mounting point.
  const amazonListing = useMemo(() => listingImages.filter((i) => i.platform === 'AMAZON'), [listingImages])
  const ebayListing   = useMemo(() => listingImages.filter((i) => i.platform === 'EBAY'),   [listingImages])
  const shopifyListing = useMemo(() => listingImages.filter((i) => i.platform === 'SHOPIFY'), [listingImages])

  const amazonPending = useMemo(() => Array.from(pendingUpserts.values()).filter((u) => u.platform === 'AMAZON'), [pendingUpserts])
  const ebayPending   = useMemo(() => Array.from(pendingUpserts.values()).filter((u) => u.platform === 'EBAY'),   [pendingUpserts])
  const shopifyPending = useMemo(() => Array.from(pendingUpserts.values()).filter((u) => u.platform === 'SHOPIFY'), [pendingUpserts])

  const ebayValidation    = useChannelValidation({ channel: 'EBAY', masterImages, channelImages: ebayListing, pendingForChannel: ebayPending, pendingDeletes })
  const shopifyValidation = useChannelValidation({ channel: 'SHOPIFY', masterImages, channelImages: shopifyListing, pendingForChannel: shopifyPending, pendingDeletes })

  const ebayStale    = useMemo(() => findStaleListingImages(masterImages, ebayListing).total,    [masterImages, ebayListing])
  const shopifyStale = useMemo(() => findStaleListingImages(masterImages, shopifyListing).total, [masterImages, shopifyListing])

  // Amazon coarse summary (server-side IA.4 owns full validation).
  const amazonSummary = useMemo(() => {
    const variantsWithAsin = variants.filter((v) => !!v.amazonAsin).length
    const masterHasMain = masterImages.some((m) => m.type === 'MAIN')
    const amazonHasMain = amazonListing.some((i) => i.amazonSlot === 'MAIN') || masterHasMain
    return {
      variantsWithAsin,
      totalVariants: variants.length,
      hasMain: amazonHasMain,
      hasContent: amazonListing.length > 0 || masterImages.length > 0,
      pendingCount: amazonPending.length,
    }
  }, [variants, masterImages, amazonListing, amazonPending])

  // Default selection: all channels with content AND no blocking
  // issues. Operator can toggle.
  const [selected, setSelected] = useState<Set<ChannelKey>>(() => {
    const out = new Set<ChannelKey>()
    if (amazonSummary.hasContent && amazonSummary.hasMain) out.add('AMAZON')
    if (ebayListing.length + masterImages.length > 0 && ebayValidation.blocking.length === 0) out.add('EBAY')
    if (shopifyListing.length + masterImages.length > 0 && shopifyValidation.blocking.length === 0) out.add('SHOPIFY')
    return out
  })

  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [publishing, setPublishing] = useState(false)
  const [done, setDone] = useState(false)

  function toggle(channel: ChannelKey) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(channel)) next.delete(channel)
      else next.add(channel)
      return next
    })
  }

  function targetFor(channel: ChannelKey): PublishTarget {
    if (channel === 'AMAZON') return { channel: 'AMAZON', marketplace: 'ALL' }
    if (channel === 'EBAY') return { channel: 'EBAY' }
    return { channel: 'SHOPIFY' }
  }

  async function run() {
    if (publishing || selected.size === 0) return
    setPublishing(true)
    setDone(false)
    const initial: ProgressEntry[] = Array.from(selected).map((c) => ({ channel: c, status: 'pending' }))
    setProgress(initial)

    for (const channel of selected) {
      setProgress((prev) => prev.map((p) => (p.channel === channel ? { ...p, status: 'in-progress' } : p)))
      try {
        await onPublishChannel(targetFor(channel))
        setProgress((prev) => prev.map((p) => (p.channel === channel ? { ...p, status: 'done' } : p)))
      } catch (err) {
        setProgress((prev) => prev.map((p) => (p.channel === channel
          ? { ...p, status: 'error', message: err instanceof Error ? err.message : 'Publish failed' }
          : p)))
      }
    }
    setDone(true)
    setPublishing(false)
  }

  function reset() {
    setProgress([])
    setDone(false)
  }

  if (!open) return null

  const anySelectable =
    (amazonSummary.hasContent && amazonSummary.hasMain) ||
    (ebayListing.length + masterImages.length > 0 && ebayValidation.blocking.length === 0) ||
    (shopifyListing.length + masterImages.length > 0 && shopifyValidation.blocking.length === 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={publishing ? undefined : onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Cross-channel publish preview
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Select channels to publish in one pass. Each runs sequentially.
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} disabled={publishing} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {!anySelectable && (
          <div className="px-5 py-4 text-xs text-slate-500 dark:text-slate-400">
            No channels are ready to publish. Add images at master level, or fix blocking
            issues in the per-channel preview modals, then try again.
          </div>
        )}

        {/* Channel cards */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <ChannelCard
            channel="AMAZON"
            label="Amazon"
            icon="A"
            iconBg="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
            checked={selected.has('AMAZON')}
            disabled={!amazonSummary.hasContent || !amazonSummary.hasMain || publishing}
            onChange={() => toggle('AMAZON')}
            statusBadge={
              !amazonSummary.hasContent
                ? { tone: 'muted', label: 'No content' }
                : !amazonSummary.hasMain
                  ? { tone: 'rose', label: 'No MAIN image' }
                  : { tone: 'emerald', label: 'Ready' }
            }
            bullets={[
              `${amazonSummary.variantsWithAsin}/${amazonSummary.totalVariants} variants with ASIN`,
              'Publishes to all 5 markets (IT · DE · FR · ES · UK)',
              amazonSummary.pendingCount > 0
                ? `${amazonSummary.pendingCount} pending change${amazonSummary.pendingCount === 1 ? '' : 's'} (will save first)`
                : 'No pending changes',
            ]}
          />

          <ChannelCard
            channel="EBAY"
            label="eBay"
            icon={<ShoppingBag className="w-4 h-4" />}
            iconBg="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            checked={selected.has('EBAY')}
            disabled={ebayValidation.blocking.length > 0 || publishing || (ebayListing.length + masterImages.length === 0)}
            onChange={() => toggle('EBAY')}
            statusBadge={
              ebayValidation.blocking.length > 0
                ? { tone: 'rose', label: `${ebayValidation.blocking.length} blocking` }
                : ebayValidation.warnings.length > 0
                  ? { tone: 'amber', label: `${ebayValidation.warnings.length} warning${ebayValidation.warnings.length === 1 ? '' : 's'}` }
                  : ebayStale > 0
                    ? { tone: 'amber', label: `${ebayStale} stale` }
                    : { tone: 'emerald', label: 'Ready' }
            }
            bullets={[
              `${ebayValidation.resolvedCount} image${ebayValidation.resolvedCount === 1 ? '' : 's'} ready${ebayValidation.source === 'master' ? ' (master fallback)' : ''}`,
              ebayPending.length > 0
                ? `${ebayPending.length} pending change${ebayPending.length === 1 ? '' : 's'} (will save first)`
                : 'No pending changes',
              ebayStale > 0 ? `${ebayStale} image${ebayStale === 1 ? '' : 's'} stale on eBay` : null,
              ...ebayValidation.blocking.slice(0, 2).map((i) => `Blocking: ${i.message}`),
            ].filter(Boolean) as string[]}
          />

          <ChannelCard
            channel="SHOPIFY"
            label="Shopify"
            icon={<Store className="w-4 h-4" />}
            iconBg="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
            checked={selected.has('SHOPIFY')}
            disabled={shopifyValidation.blocking.length > 0 || publishing || (shopifyListing.length + masterImages.length === 0)}
            onChange={() => toggle('SHOPIFY')}
            statusBadge={
              shopifyValidation.blocking.length > 0
                ? { tone: 'rose', label: `${shopifyValidation.blocking.length} blocking` }
                : shopifyValidation.warnings.length > 0
                  ? { tone: 'amber', label: `${shopifyValidation.warnings.length} warning${shopifyValidation.warnings.length === 1 ? '' : 's'}` }
                  : shopifyStale > 0
                    ? { tone: 'amber', label: `${shopifyStale} stale` }
                    : { tone: 'emerald', label: 'Ready' }
            }
            bullets={[
              `${shopifyValidation.resolvedCount} image${shopifyValidation.resolvedCount === 1 ? '' : 's'} ready${shopifyValidation.source === 'master' ? ' (master fallback)' : ''}`,
              shopifyPending.length > 0
                ? `${shopifyPending.length} pending change${shopifyPending.length === 1 ? '' : 's'} (will save first)`
                : 'No pending changes',
              shopifyStale > 0 ? `${shopifyStale} image${shopifyStale === 1 ? '' : 's'} stale on Shopify` : null,
              ...shopifyValidation.blocking.slice(0, 2).map((i) => `Blocking: ${i.message}`),
            ].filter(Boolean) as string[]}
          />

          {/* Progress block */}
          {progress.length > 0 && (
            <div className="mt-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 space-y-1.5">
              <div className="text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
                {done ? 'Done' : 'Publishing…'}
              </div>
              {progress.map((p) => (
                <div key={p.channel} className="flex items-center gap-2 text-xs">
                  {p.status === 'pending'   && <span className="w-3 h-3 rounded-full border border-slate-300 dark:border-slate-600" />}
                  {p.status === 'in-progress' && <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
                  {p.status === 'done'      && <CheckCircle2 className="w-3 h-3 text-emerald-500" />}
                  {p.status === 'error'     && <AlertTriangle className="w-3 h-3 text-rose-500" />}
                  <span className="font-mono text-slate-700 dark:text-slate-300">{labelFor(p.channel)}</span>
                  <span className="text-slate-400">—</span>
                  <span className={cn(
                    p.status === 'done' && 'text-emerald-600 dark:text-emerald-400',
                    p.status === 'error' && 'text-rose-600 dark:text-rose-400',
                  )}>
                    {p.status === 'pending'   && 'Queued'}
                    {p.status === 'in-progress' && 'Submitting…'}
                    {p.status === 'done'      && 'Published'}
                    {p.status === 'error'     && (p.message ?? 'Failed')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2 bg-slate-50/50 dark:bg-slate-900/50">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {selected.size} channel{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            {done && (
              <Button size="sm" variant="ghost" onClick={reset} disabled={publishing}>
                Reset
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose} disabled={publishing}>
              {done ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              disabled={selected.size === 0 || publishing || done}
              onClick={() => void run()}
              className="gap-1.5"
            >
              {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              {publishing
                ? 'Publishing…'
                : done
                  ? 'Finished'
                  : `Publish to ${selected.size} channel${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function labelFor(channel: ChannelKey): string {
  if (channel === 'AMAZON') return 'Amazon (all markets)'
  if (channel === 'EBAY') return 'eBay'
  return 'Shopify'
}

function ChannelCard({
  channel: _channel,
  label,
  icon,
  iconBg,
  checked,
  disabled,
  onChange,
  statusBadge,
  bullets,
}: {
  channel: ChannelKey
  label: string
  icon: React.ReactNode
  iconBg: string
  checked: boolean
  disabled: boolean
  onChange: () => void
  statusBadge: { tone: 'emerald' | 'amber' | 'rose' | 'muted'; label: string }
  bullets: string[]
}) {
  const toneClass =
    statusBadge.tone === 'emerald' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' :
    statusBadge.tone === 'amber'   ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
    statusBadge.tone === 'rose'    ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300' :
                                     'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'

  return (
    <label className={cn(
      'flex items-start gap-3 px-3 py-3 rounded-xl border cursor-pointer transition-colors',
      checked
        ? 'border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20'
        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50',
      disabled && 'opacity-50 cursor-not-allowed',
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-1 w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 flex-shrink-0"
      />
      <div className={cn('flex items-center justify-center w-7 h-7 rounded-md font-mono text-sm font-semibold flex-shrink-0', iconBg)}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
          <span className={cn('text-[10px] uppercase font-semibold px-1.5 py-px rounded tracking-wide', toneClass)}>
            {statusBadge.label}
          </span>
        </div>
        <ul className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5 leading-snug">
          {bullets.map((b, i) => (
            <li key={i}>• {b}</li>
          ))}
        </ul>
      </div>
    </label>
  )
}
