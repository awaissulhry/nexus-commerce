'use client'

// EC.7 — ImagesCard
//
// Reads IM.5's existing /api/products/:id/listing-images endpoint —
// no duplicate store, no new API. Surfaces the eBay-relevant view:
//
//   • Hero (primary master image)
//   • Master gallery (up to 24 thumbs, click-to-link Images tab)
//   • Per-color VariationSpecificPictureSet chips (eBay's name for
//     "this set of images goes with this colour variant")
//   • Stale-image banner — fires when the product was updated AFTER
//     the most-recent listing-image (mirrors PB.3d's gate)
//   • Open Images tab — deep link for full management
//
// Reorder + replace + delete still live in the Images tab. The
// cockpit card stays a READ + light navigation surface so we don't
// duplicate IM.5's logic. EC.7b would inline reorder via the
// existing /reorder endpoint if operators ask for it.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Image as ImageIcon, ExternalLink, AlertTriangle, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface MasterImage {
  id: string
  url: string
  alt: string | null
  type: string
  createdAt: string
}

interface ListingImageOverride {
  id: string
  url: string
  alt: string | null
  scope: 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
  platform: string | null
  marketplace: string | null
  variantGroupKey: string | null
  variantGroupValue: string | null
  role: string
  position: number
  updatedAt: string
  publishStatus: string
  publishedAt: string | null
}

interface Response {
  product: { id: string; sku: string; name: string; isParent: boolean }
  master: MasterImage[]
  overrides: ListingImageOverride[]
  variants: Array<{ id: string; sku: string; name: string; variantAttributes: Record<string, string> | null }>
}

interface Props {
  productId: string
  marketplace: string
  /** Used by the stale-image check — when product was updated after
   *  the freshest listing-image we show a soft warning. */
  productUpdatedAt: string | null
}

export default function ImagesCard({ productId, marketplace, productUpdatedAt }: Props) {
  const { t } = useTranslations()
  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let aborted = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/listing-images`,
        )
        const json = await res.json()
        if (aborted) return
        if (!res.ok) setError(json?.error ?? `HTTP ${res.status}`)
        else setData(json as Response)
      } catch (err) {
        if (!aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => { aborted = true }
  }, [productId])

  // Filter overrides to eBay AND (no marketplace = all-eBay scope OR
  // this exact marketplace). VariationSpecificPictureSet rows usually
  // have marketplace=null since eBay applies them globally per item.
  const ebayOverrides = useMemo(
    () =>
      (data?.overrides ?? []).filter((o) => {
        if (o.platform && o.platform.toUpperCase() !== 'EBAY') return false
        if (o.marketplace && o.marketplace !== marketplace) return false
        return true
      }),
    [data, marketplace],
  )

  // Group overrides by colour set ("Color → Black" etc).
  const colorSets = useMemo(() => {
    const map = new Map<string, ListingImageOverride[]>()
    for (const o of ebayOverrides) {
      if (!o.variantGroupKey || !o.variantGroupValue) continue
      const key = `${o.variantGroupKey}:${o.variantGroupValue}`
      const arr = map.get(key) ?? []
      arr.push(o)
      map.set(key, arr)
    }
    return Array.from(map.entries())
      .map(([key, images]) => {
        const [axis, value] = key.split(':')
        return { axis: axis ?? '', value: value ?? '', images: images.sort((a, b) => a.position - b.position) }
      })
      .sort((a, b) => (a.value ?? '').localeCompare(b.value ?? ''))
  }, [ebayOverrides])

  // Sort master images: MAIN first (sorted by createdAt), then everything else.
  const masterSorted = useMemo(() => {
    if (!data) return []
    return [...data.master].sort((a, b) => {
      const aMain = (a.type ?? '').toUpperCase() === 'MAIN' ? 0 : 1
      const bMain = (b.type ?? '').toUpperCase() === 'MAIN' ? 0 : 1
      if (aMain !== bMain) return aMain - bMain
      return a.createdAt.localeCompare(b.createdAt)
    })
  }, [data])
  const hero = masterSorted[0] ?? null

  // Stale check: product updated AFTER the freshest listing image.
  const isStale = useMemo(() => {
    if (!productUpdatedAt || ebayOverrides.length === 0) return false
    const freshest = ebayOverrides.reduce<string>((acc, o) => (o.updatedAt > acc ? o.updatedAt : acc), '')
    if (!freshest) return false
    return new Date(productUpdatedAt) > new Date(freshest)
  }, [productUpdatedAt, ebayOverrides])

  const imagesTabHref = `/products/${productId}/edit?tab=images`

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <ImageIcon className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">{t('products.edit.cockpit.ebay.images.title')}</div>
        <Badge variant="info">EC.7</Badge>
        {data && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {data.master.length} {t('products.edit.cockpit.ebay.images.masterLabel')} · {colorSets.length} {colorSets.length === 1 ? t('products.edit.cockpit.ebay.images.colorSet') : t('products.edit.cockpit.ebay.images.colorSets')} · {ebayOverrides.length} {t('products.edit.cockpit.ebay.images.ebayOverrides')}
          </span>
        )}
        <Link
          href={imagesTabHref}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          title={t('products.edit.cockpit.ebay.images.manageTitle')}
        >
          {t('products.edit.cockpit.ebay.images.manageInImagesTab')} <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      <div className="p-4 space-y-3">
        {loading && (
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('products.edit.cockpit.ebay.images.loading')}
          </div>
        )}
        {error && (
          <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {isStale && (
              <div className="text-xs px-3 py-2 rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {t('products.edit.cockpit.ebay.images.staleWarning')}
                </span>
              </div>
            )}

            {/* ── Hero + master gallery ─────────────────────────── */}
            <div className="flex gap-3 items-start">
              <div className="w-24 h-24 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 overflow-hidden flex-shrink-0">
                {hero ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={hero.url} alt={hero.alt ?? ''} className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10.5px] text-slate-400">{t('products.edit.cockpit.ebay.images.noHero')}</div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.images.masterGallery')}</div>
                <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {data.master.length} {t('products.edit.cockpit.ebay.images.imagesPrimaryLeft')}
                </div>
                {masterSorted.length > 1 && (
                  <div className="mt-2 flex gap-1 flex-wrap">
                    {masterSorted.slice(0, 16).map((m) => (
                      <Link
                        key={m.id}
                        href={imagesTabHref}
                        className="w-10 h-10 rounded border border-slate-200 dark:border-slate-700 overflow-hidden hover:ring-2 hover:ring-blue-300"
                        title={m.alt ?? m.type ?? ''}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={m.url} alt="" className="w-full h-full object-cover" />
                      </Link>
                    ))}
                    {masterSorted.length > 16 && (
                      <span className="inline-flex items-center px-1.5 text-[10.5px] text-slate-400 self-center">
                        + {masterSorted.length - 16}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Per-colour sets ───────────────────────────────── */}
            {colorSets.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  {t('products.edit.cockpit.ebay.images.variationPictureSets')} ({colorSets.length})
                </div>
                <div className="space-y-1.5">
                  {colorSets.map((set) => (
                    <div
                      key={`${set.axis}:${set.value}`}
                      className="flex items-center gap-2 px-2 py-1.5 rounded border border-slate-100 dark:border-slate-800"
                    >
                      <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                        {set.axis} · {set.value}
                      </span>
                      <div className="flex gap-1 flex-1 overflow-x-auto">
                        {set.images.slice(0, 8).map((img) => (
                          <Link
                            key={img.id}
                            href={imagesTabHref}
                            className={cn(
                              'w-9 h-9 rounded border overflow-hidden flex-shrink-0 hover:ring-2 hover:ring-blue-300',
                              img.publishStatus === 'PUBLISHED'
                                ? 'border-emerald-200 dark:border-emerald-800'
                                : img.publishStatus === 'FAILED'
                                ? 'border-rose-200 dark:border-rose-800'
                                : 'border-slate-200 dark:border-slate-700',
                            )}
                            title={`pos ${img.position} · ${img.publishStatus}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.url} alt="" className="w-full h-full object-cover" />
                          </Link>
                        ))}
                      </div>
                      <span className="text-[10.5px] text-slate-400 ml-auto whitespace-nowrap">
                        {set.images.length} / 24
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {colorSets.length === 0 && data.product.isParent && (
              <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                {t('products.edit.cockpit.ebay.images.noColorSetsEmpty')}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
