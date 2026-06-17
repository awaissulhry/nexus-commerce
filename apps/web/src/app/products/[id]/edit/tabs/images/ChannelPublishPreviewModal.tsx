'use client'

// PB.3b — Pre-publish preview modal for eBay + Shopify.
//
// Mirror of the Amazon PublishPreviewModal (IA.2) for the other two
// channels. Computes the same per-color / per-variant resolution the
// publish handler would do, shows coverage stats + reused validation
// banner from PB.3a, and offers a single confirm button that's
// disabled when blocking issues exist.
//
// One modal handles both eBay + Shopify with channel-conditional
// detail sections, because the underlying data shapes (gallery + color
// sets vs pool + variant assignments) are channel-specific.

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import ChannelValidationBanner, { useChannelValidation } from './ChannelValidationBanner'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary } from './types'

interface Props {
  open: boolean
  channel: 'EBAY' | 'SHOPIFY'
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  pendingUpserts: Map<string, PendingUpsert>
  pendingDeletes: Set<string>
  variants: VariantSummary[]
  activeAxis: string
  publishing: boolean
  onClose: () => void
  onConfirmPublish: () => void
}

interface GalleryEntry {
  url: string
  position: number
  isPending: boolean
  source: 'channel' | 'master'
}

interface ColorSetEntry {
  groupValue: string
  variants: VariantSummary[]
  images: { url: string; isPending: boolean }[]
}

interface VariantAssignmentEntry {
  variant: VariantSummary
  assignedUrl: string | null
  source: 'variant' | 'group' | 'pool-fallback' | 'master-fallback' | 'none'
  poolPosition: number | null
}

export default function ChannelPublishPreviewModal({
  open,
  channel,
  masterImages,
  listingImages,
  pendingUpserts,
  pendingDeletes,
  variants,
  activeAxis,
  publishing,
  onClose,
  onConfirmPublish,
}: Props) {
  const [confirming, setConfirming] = useState(false)

  // Pre-filter to this channel only — saves repeated platform checks
  // across the various useMemo derivations below.
  const channelImages = useMemo(
    () => listingImages.filter((i) => i.platform === channel),
    [listingImages, channel],
  )
  const channelPending = useMemo(
    () => Array.from(pendingUpserts.values()).filter((u) => u.platform === channel),
    [pendingUpserts, channel],
  )

  // PB.3a validation, reused. Drives publish-disable + banner.
  const validation = useChannelValidation({
    channel,
    masterImages,
    channelImages,
    pendingForChannel: channelPending,
    pendingDeletes,
  })

  // ── Gallery / pool (product-level, no variantGroupKey) ──────────────
  const gallery = useMemo<GalleryEntry[]>(() => {
    const savedById = new Map(channelImages.filter((i) => !i.variantGroupKey && !pendingDeletes.has(i.id)).map((i) => [i.id, i]))
    const pendingNew: GalleryEntry[] = []
    for (const u of channelPending) {
      if (u.variantGroupKey) continue
      if (u.id) {
        // Pending replacement of a saved row
        savedById.set(u.id, { ...savedById.get(u.id)!, url: u.url, position: u.position ?? 0 })
      } else {
        pendingNew.push({ url: u.url, position: u.position ?? 999, isPending: true, source: 'channel' })
      }
    }
    const merged: GalleryEntry[] = [
      ...Array.from(savedById.values()).map<GalleryEntry>((i) => ({
        url: i.url,
        position: i.position,
        isPending: false,
        source: 'channel',
      })),
      ...pendingNew,
    ].sort((a, b) => a.position - b.position)

    // Empty channel → fall back to master (matches publish resolver).
    if (merged.length > 0) return merged
    return masterImages.map((m, idx) => ({
      url: m.url,
      position: idx,
      isPending: false,
      source: 'master',
    }))
  }, [channelImages, channelPending, pendingDeletes, masterImages])

  // ── Variant group buckets (axis values from variants) ───────────────
  const variantGroups = useMemo(() => {
    const map = new Map<string, VariantSummary[]>()
    for (const v of variants) {
      const val = (v.variantAttributes as Record<string, string> | null)?.[activeAxis]
      if (!val) continue
      const arr = map.get(val) ?? []
      arr.push(v)
      map.set(val, arr)
    }
    return map
  }, [variants, activeAxis])

  // ── eBay color sets ─────────────────────────────────────────────────
  const colorSets = useMemo<ColorSetEntry[]>(() => {
    if (channel !== 'EBAY') return []
    const out: ColorSetEntry[] = []
    for (const [groupValue, vs] of variantGroups) {
      const images: ColorSetEntry['images'] = []
      for (const img of channelImages) {
        if (img.variantGroupKey !== activeAxis || img.variantGroupValue !== groupValue) continue
        if (pendingDeletes.has(img.id)) continue
        images.push({ url: img.url, isPending: false })
      }
      for (const u of channelPending) {
        if (u.variantGroupKey !== activeAxis || u.variantGroupValue !== groupValue) continue
        if (u.id) continue
        images.push({ url: u.url, isPending: true })
      }
      out.push({ groupValue, variants: vs, images })
    }
    return out.sort((a, b) => a.groupValue.localeCompare(b.groupValue))
  }, [channel, variantGroups, channelImages, channelPending, pendingDeletes, activeAxis])

  // ── Shopify variant assignments ─────────────────────────────────────
  const variantAssignments = useMemo<VariantAssignmentEntry[]>(() => {
    if (channel !== 'SHOPIFY') return []
    const groupAssignment = new Map<string, string>()
    for (const img of channelImages) {
      if (img.variantGroupKey !== activeAxis || !img.variantGroupValue) continue
      if (pendingDeletes.has(img.id)) continue
      groupAssignment.set(img.variantGroupValue, img.url)
    }
    for (const u of channelPending) {
      if (u.variantGroupKey !== activeAxis || !u.variantGroupValue) continue
      groupAssignment.set(u.variantGroupValue, u.url)
    }

    const out: VariantAssignmentEntry[] = []
    for (const v of variants) {
      const groupVal = (v.variantAttributes as Record<string, string> | null)?.[activeAxis]
      const groupUrl = groupVal ? groupAssignment.get(groupVal) ?? null : null
      if (groupUrl) {
        out.push({
          variant: v,
          assignedUrl: groupUrl,
          source: 'group',
          poolPosition: gallery.findIndex((g) => g.url === groupUrl) >= 0 ? gallery.findIndex((g) => g.url === groupUrl) : null,
        })
        continue
      }
      // Fall back to first gallery entry (Shopify shows featured image).
      const fallback = gallery[0]
      if (fallback) {
        out.push({
          variant: v,
          assignedUrl: fallback.url,
          source: fallback.source === 'master' ? 'master-fallback' : 'pool-fallback',
          poolPosition: 0,
        })
        continue
      }
      out.push({ variant: v, assignedUrl: null, source: 'none', poolPosition: null })
    }
    return out
  }, [channel, channelImages, channelPending, pendingDeletes, variants, activeAxis, gallery])

  if (!open) return null

  const blocked = validation.blocking.length > 0
  const channelLabel = channel === 'EBAY' ? 'eBay' : 'Shopify'
  const maxImages = channel === 'EBAY' ? 24 : 250

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-default dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Publish preview — {channelLabel}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {channel === 'EBAY'
                ? 'Gallery + variation pictures sent to ReviseItem on next publish.'
                : 'Pool + per-variant image assignments synced on next publish.'}
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Coverage strip */}
        <div className="px-5 py-3 border-b border-subtle dark:border-slate-800 flex items-center gap-4 text-xs flex-wrap">
          <span className="text-slate-500 dark:text-slate-400">
            {channel === 'EBAY' ? 'Gallery:' : 'Pool:'}
          </span>
          <span className="font-mono text-slate-700 dark:text-slate-200">
            {gallery.length}/{maxImages}{gallery[0]?.source === 'master' && ' (master fallback)'}
          </span>

          {channel === 'EBAY' && colorSets.length > 0 && (
            <>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {colorSets.filter((s) => s.images.length > 0).length}/{colorSets.length} colors with sets
              </span>
            </>
          )}

          {channel === 'SHOPIFY' && variantAssignments.length > 0 && (
            <>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {variantAssignments.filter((a) => a.assignedUrl).length}/{variantAssignments.length} variants assigned
              </span>
              {variantAssignments.some((a) => a.source === 'pool-fallback' || a.source === 'master-fallback') && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3 h-3" />
                  some via fallback
                </span>
              )}
            </>
          )}

          {activeAxis && (
            <span className="text-tertiary ml-auto">axis: {activeAxis}</span>
          )}
        </div>

        {/* Validation banner — reused PB.3a */}
        <ChannelValidationBanner
          channel={channel}
          masterImages={masterImages}
          channelImages={channelImages}
          pendingForChannel={channelPending}
          pendingDeletes={pendingDeletes}
        />

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Gallery / Pool */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
              {channel === 'EBAY' ? 'Gallery' : 'Pool'}
              <span className="font-normal normal-case text-tertiary ml-2">
                — position {channel === 'EBAY' ? '1 is the main listing image' : '0 is the featured image'}
              </span>
            </h3>
            {gallery.length === 0 ? (
              <div className="text-xs text-tertiary italic py-3">No images will publish.</div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {gallery.map((g, idx) => (
                  <ThumbCard
                    key={`g-${idx}`}
                    url={g.url}
                    position={idx + (channel === 'SHOPIFY' ? 0 : 1)}
                    isHero={idx === 0}
                    isPending={g.isPending}
                    fromMaster={g.source === 'master'}
                  />
                ))}
              </div>
            )}
          </section>

          {/* eBay color sets */}
          {channel === 'EBAY' && colorSets.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Variation pictures
                <span className="font-normal normal-case text-tertiary ml-2">
                  — per-{activeAxis} sets (12 max per value)
                </span>
              </h3>
              <div className="space-y-2">
                {colorSets.map((set) => (
                  <div key={set.groupValue} className="flex items-start gap-3 py-2 border-b border-subtle dark:border-slate-800 last:border-0">
                    <div className="flex-shrink-0 w-24 pt-1">
                      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{set.groupValue}</div>
                      <div className="text-[10px] text-tertiary">{set.variants.length} SKU{set.variants.length === 1 ? '' : 's'}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      {set.images.length === 0 ? (
                        <div className="text-[11px] text-tertiary italic">
                          No pictures — buyers see the gallery on color select.
                        </div>
                      ) : (
                        <div className="flex gap-1.5 flex-wrap">
                          {set.images.map((img, idx) => (
                            <ThumbCard key={`s-${idx}`} url={img.url} size="sm" isPending={img.isPending} />
                          ))}
                          <span className="text-[10px] text-tertiary self-end pb-1">
                            {set.images.length} image{set.images.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Shopify variant assignments */}
          {channel === 'SHOPIFY' && variantAssignments.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Variant assignments
                <span className="font-normal normal-case text-tertiary ml-2">
                  — variant.image_id on next publish
                </span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500 dark:text-slate-400 border-b border-subtle dark:border-slate-800">
                      <th className="py-1.5 pr-3 font-medium">SKU</th>
                      <th className="py-1.5 pr-3 font-medium">{activeAxis}</th>
                      <th className="py-1.5 pr-3 font-medium">Image</th>
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variantAssignments.map((a) => (
                      <tr key={a.variant.id} className="border-b border-slate-50 dark:border-slate-800/50 last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{a.variant.sku}</td>
                        <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-400">
                          {(a.variant.variantAttributes as Record<string, string> | null)?.[activeAxis] ?? '—'}
                        </td>
                        <td className="py-1.5 pr-3">
                          {a.assignedUrl
                            ? <ThumbCard url={a.assignedUrl} size="xs" />
                            : <span className="text-rose-500 font-mono text-[10px]">NONE</span>}
                        </td>
                        <td className="py-1.5 pr-3">
                          <SourcePill source={a.source} poolPosition={a.poolPosition} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-default dark:border-slate-700 flex items-center gap-2 bg-slate-50/50 dark:bg-slate-900/50">
          {validation.blocking.length === 0 && validation.warnings.length === 0 && gallery.length > 0 && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Ready to publish
            </span>
          )}
          {validation.warnings.length > 0 && validation.blocking.length === 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              {validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'} — publish still allowed
            </span>
          )}
          {validation.blocking.length > 0 && (
            <span className="text-xs text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              {validation.blocking.length} blocking — fix before publish
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={publishing || confirming}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={blocked || publishing || confirming || gallery.length === 0}
              onClick={async () => {
                setConfirming(true)
                try {
                  await onConfirmPublish()
                } finally {
                  setConfirming(false)
                }
              }}
              className="gap-1.5"
            >
              {(publishing || confirming) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Publish to {channelLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ThumbCard({
  url,
  position,
  isHero,
  isPending,
  fromMaster,
  size = 'md',
}: {
  url: string
  position?: number
  isHero?: boolean
  isPending?: boolean
  fromMaster?: boolean
  size?: 'xs' | 'sm' | 'md'
}) {
  const dim = size === 'xs' ? 'w-8 h-8' : size === 'sm' ? 'w-12 h-12' : 'w-16 h-16'
  return (
    <div className={cn(
      'relative rounded overflow-hidden border flex-shrink-0',
      dim,
      isPending
        ? 'border-amber-300 dark:border-amber-700 ring-1 ring-amber-400/40'
        : fromMaster
          ? 'border-dashed border-slate-300 dark:border-slate-600'
          : 'border-default dark:border-slate-700',
    )}>
      <img src={url} alt="" className="w-full h-full object-cover" />
      {isHero && position !== undefined && (
        <div className="absolute top-0 left-0 px-1 py-px text-[8px] bg-blue-600 text-white inline-flex items-center gap-0.5 rounded-br">
          <Star className="w-2 h-2" />
          {size === 'md' ? 'MAIN' : ''}
        </div>
      )}
      {!isHero && position !== undefined && size !== 'xs' && (
        <div className="absolute top-0 left-0 px-1 text-[8px] bg-slate-900/70 text-white rounded-br">
          {position}
        </div>
      )}
      {isPending && (
        <div className="absolute top-0 right-0 px-1 text-[8px] bg-amber-500 text-white rounded-bl">
          PEND
        </div>
      )}
    </div>
  )
}

function SourcePill({ source, poolPosition }: { source: VariantAssignmentEntry['source']; poolPosition: number | null }) {
  if (source === 'group') {
    return <span className="font-mono text-[10px] px-1.5 py-px rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">variant assignment</span>
  }
  if (source === 'pool-fallback') {
    return <span className="font-mono text-[10px] px-1.5 py-px rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">pool #{poolPosition}</span>
  }
  if (source === 'master-fallback') {
    return <span className="font-mono text-[10px] px-1.5 py-px rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">master fallback</span>
  }
  return <span className="font-mono text-[10px] px-1.5 py-px rounded bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300">none</span>
}
