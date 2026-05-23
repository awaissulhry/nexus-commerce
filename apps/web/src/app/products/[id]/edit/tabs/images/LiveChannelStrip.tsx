'use client'

// IE.5 — Live channel image strip.
//
// Sits above the Amazon matrix and renders what's currently on each
// marketplace. Compares the live URLs against the Nexus
// ListingImage cascade output for the same (sku, slot) and flags
// drift with a ⚠ pill. Click a flagged thumb to open the drift
// modal.
//
// Empty state: no rows yet → "Refresh" CTA fetches via SP-API. After
// IE.4b's cron ships this strip is mostly read-only with refresh
// only as a manual override.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { beFetch } from './api'
import type { ChannelLiveImage, ListingImage } from './types'

interface Props {
  productId: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
  marketplaces: readonly string[]
  liveImages: ChannelLiveImage[]
  listingImages: ListingImage[]
  onRefreshed: () => void
  onAdoptToMaster?: (url: string, marketplace: string | null, slot: string | null) => void
  onOpenDiff?: (live: ChannelLiveImage, nexusUrl: string | null) => void
}

function elapsed(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function LiveChannelStrip({
  productId,
  channel,
  marketplaces,
  liveImages,
  listingImages,
  onRefreshed,
  onAdoptToMaster,
  onOpenDiff,
}: Props) {
  const { t } = useTranslations()
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // IA.8 — Persisted collapse state. Key namespaced by channel so a
  // collapsed Amazon strip doesn't auto-collapse the eBay one when
  // those land. Default open on first visit; on subsequent loads
  // honour the operator's last choice.
  const collapseKey = `ie.liveStrip.collapsed.${channel}`
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem(collapseKey) === '1' } catch { return false }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(collapseKey, collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed, collapseKey])

  // Group live images by marketplace (Amazon only has marketplace
  // today). Within each, group by externalSku so the strip surfaces
  // per-ASIN rows rather than collapsing across the whole catalog.
  const byMarketplace = useMemo(() => {
    const out = new Map<string, ChannelLiveImage[]>()
    for (const li of liveImages) {
      if (li.channel !== channel) continue
      const key = li.marketplace ?? 'GLOBAL'
      const arr = out.get(key) ?? []
      arr.push(li)
      out.set(key, arr)
    }
    for (const arr of out.values()) {
      arr.sort((a, b) => {
        if (a.externalSku !== b.externalSku) return (a.externalSku ?? '').localeCompare(b.externalSku ?? '')
        return a.sortOrder - b.sortOrder
      })
    }
    return out
  }, [liveImages, channel])

  // Drift map: for each live image, find the matching Nexus
  // ListingImage by (slot, marketplace) and report whether the URL
  // matches. No matching Nexus row → "orphan" (Nexus doesn't know
  // about this image at all). URL mismatch → "diff".
  function nexusUrlFor(live: ChannelLiveImage): string | null {
    if (channel !== 'AMAZON' || !live.slot) return null
    const hit = listingImages.find(
      (li) =>
        li.platform === 'AMAZON' &&
        li.amazonSlot === live.slot &&
        (li.marketplace === live.marketplace ||
          (li.scope === 'PLATFORM' && !li.marketplace)),
    )
    return hit?.url ?? null
  }

  async function refresh(marketplace: string) {
    setRefreshing((p) => ({ ...p, [marketplace]: true }))
    setRefreshError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/live-channel-images/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, marketplace }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Refresh failed: ${res.status}`)
      }
      onRefreshed()
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing((p) => ({ ...p, [marketplace]: false }))
    }
  }

  // For channels (eBay/Shopify) where IE.4 didn't wire a fetch yet,
  // render a muted "not yet wired" notice instead of a refresh CTA.
  const supported = channel === 'AMAZON'

  return (
    <section className="mb-4 bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      {/* IA.8 — Header is a button that toggles the body. Chevron
          rotates; whole row is clickable so the hit target is large. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full px-4 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2 hover:bg-slate-100/50 dark:hover:bg-slate-800/30 transition-colors"
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
          {t('products.edit.images.liveStrip.headerTitle', {
            channel: channel.charAt(0) + channel.slice(1).toLowerCase(),
          })}
        </span>
        <span className="text-[11px] text-slate-400">
          {t('products.edit.images.liveStrip.cachedCount', {
            count: liveImages.filter((l) => l.channel === channel).length,
          })}
        </span>
        {refreshError && (
          <span className="text-[11px] text-red-500 ml-auto">{refreshError}</span>
        )}
      </button>

      {collapsed ? null : (
      <div className="px-4 py-3 space-y-3">
        {!supported && (
          <p className="text-xs text-slate-500 dark:text-slate-400 italic">
            {t('products.edit.images.liveStrip.notWired', { channel: channel.toLowerCase() })}
          </p>
        )}

        {marketplaces.map((mkt) => {
          const rows = byMarketplace.get(mkt) ?? []
          const isRefreshing = !!refreshing[mkt]
          return (
            <div key={mkt} className="flex items-start gap-3">
              <div className="w-12 flex-shrink-0 pt-1">
                <span className="text-[11px] font-mono font-semibold text-slate-500 dark:text-slate-400">
                  {mkt}
                </span>
                {rows.length > 0 && (
                  <span className="block text-[10px] text-slate-400 mt-0.5">{elapsed(rows[0].fetchedAt)}</span>
                )}
              </div>
              <div className="flex-1 min-h-[3rem] flex items-center gap-1.5 flex-wrap">
                {rows.length === 0 ? (
                  <span className="text-[11px] text-slate-400 italic">
                    {t('products.edit.images.liveStrip.noSnapshot')}
                  </span>
                ) : (
                  rows.map((li) => {
                    const nexusUrl = nexusUrlFor(li)
                    const drift = channel === 'AMAZON' && (!nexusUrl || nexusUrl !== li.url)
                    return (
                      <button
                        key={li.id}
                        type="button"
                        // IA.8 — Live thumbs are draggable. Same dataTransfer
                        // keys the master gallery uses (application/nexus-
                        // image-url + -image-id), so any Amazon matrix cell
                        // accepts the drop and creates a pending upsert via
                        // the existing addPendingUpsert flow. Save/Discard
                        // in the action bar commits or rolls back like any
                        // other channel change.
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'copy'
                          e.dataTransfer.setData('application/nexus-image-url', li.url)
                          // No master ProductImage yet — leave the id slot
                          // empty so the cell handler treats this as a
                          // URL-only assignment (sourceProductImageId=null).
                          e.dataTransfer.setData('application/nexus-image-id', '')
                          // IA.16 — show the live thumbnail as the drag
                          // preview, not the surrounding button chrome.
                          const imgEl = e.currentTarget.querySelector('img') as HTMLImageElement | null
                          if (imgEl) e.dataTransfer.setDragImage(imgEl, imgEl.width / 2, imgEl.height / 2)
                        }}
                        onClick={() => onOpenDiff?.(li, nexusUrl)}
                        className={cn(
                          'relative w-14 h-14 rounded-md border bg-white dark:bg-slate-800 overflow-hidden hover:ring-2 hover:ring-blue-300 transition-all cursor-grab active:cursor-grabbing',
                          drift
                            ? 'border-amber-400'
                            : 'border-slate-200 dark:border-slate-700',
                        )}
                        title={`${li.slot ?? '?'}  ${li.width ?? '?'}×${li.height ?? '?'} — drag onto a cell to assign${drift ? ' (differs from Nexus)' : ''}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={li.url} alt="" className="w-full h-full object-contain pointer-events-none" loading="lazy" decoding="async" />
                        <div className="absolute top-0 left-0 text-[8px] bg-black/50 text-white px-0.5 leading-none">
                          {li.slot ?? '·'}
                        </div>
                        {drift && (
                          <div className="absolute top-0 right-0 bg-amber-500 text-white p-0.5 leading-none">
                            <AlertTriangle className="w-2.5 h-2.5" />
                          </div>
                        )}
                        {!nexusUrl && onAdoptToMaster && (
                          <span
                            role="presentation"
                            onClick={(e) => {
                              e.stopPropagation()
                              onAdoptToMaster(li.url, li.marketplace, li.slot)
                            }}
                            className="absolute bottom-0 inset-x-0 text-[8px] bg-blue-600 text-white text-center cursor-pointer hover:bg-blue-700"
                          >
                            {t('products.edit.images.liveStrip.adopt')}
                          </span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
              {supported && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[11px] h-7 gap-1 flex-shrink-0"
                  onClick={() => void refresh(mkt)}
                  disabled={isRefreshing}
                >
                  {isRefreshing
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <RefreshCcw className="w-3 h-3" />}
                  {t('products.edit.images.liveStrip.refresh')}
                </Button>
              )}
            </div>
          )
        })}
      </div>
      )}
    </section>
  )
}
