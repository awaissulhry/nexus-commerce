'use client'

// IM.3 — Images workspace tab.
//
// Shell layout: channel tabs (Master | Amazon | eBay | Shopify),
// axis selector, master panel (full), channel panels (stubs until IM.4-6),
// quality checklist sidebar, action bar (Save/Discard pending changes).
//
// Master image operations persist immediately (same as before).
// Channel listing-image assignments are staged locally and committed
// via the Save button in the action bar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { beFetch } from './images/api'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useImagesWorkspace } from './images/useImagesWorkspace'
import MasterPanel from './images/MasterPanel'
import QualityChecklist from './images/QualityChecklist'
import ImageActionBar from './images/ImageActionBar'
import type { PublishTarget } from './images/ImageActionBar'
import AmazonPanel from './images/amazon/AmazonPanel'
import EbayPanel from './images/ebay/EbayPanel'
import ShopifyPanel from './images/shopify/ShopifyPanel'
import LightboxModal from './images/LightboxModal'
import ImageEditorModal from './images/ImageEditorModal'
import DamPickerModal from './images/DamPickerModal'
import LifestyleGenerationModal from './images/LifestyleGenerationModal'
import CrossChannelPublishModal from './images/CrossChannelPublishModal'
import RollbackModal from './images/RollbackModal'
import SchedulePublishModal from './images/SchedulePublishModal'
import AutoPublishSettings from './images/AutoPublishSettings'
import ApprovalModal from './images/ApprovalModal'
import PublishHealthCards from './images/PublishHealthCards'
import PublishAuditLog from './images/PublishAuditLog'
import { captureSnapshot, type SnapshotChannel } from './images/publishSnapshotStorage'
import { readAllPrefs, type AutoPublishChannel } from './images/autoPublishPrefs'
import {
  isApprovalRequired,
  pushPendingApproval,
  readPendingApprovals,
} from './images/approvalPrefs'
import { fireBrowserNotification } from '@/lib/notifications/browser-notifications'
import { fromListing, fromMaster, useLightbox } from './images/useLightbox'
import type { LightboxImage } from './images/useLightbox'
import type { ProductImage } from './images/types'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { ChannelTab } from './images/types'

interface Props {
  product: { id: string; sku: string }
  discardSignal: number
  onDirtyChange: (count: number) => void
  /** DSP.4 — invoked BEFORE every publish so cross-tab dirty changes
   *  (Master Data, Channel Listing, etc.) persist atomically with the
   *  Images workspace flush. If it throws, publish aborts. When omitted
   *  the tab falls back to its workspace-only flush (legacy behavior). */
  onPreSaveAll?: () => Promise<void>
}

const CHANNEL_TABS: { key: ChannelTab; label: string }[] = [
  { key: 'master',  label: 'Master' },
  { key: 'amazon',  label: 'Amazon' },
  { key: 'ebay',    label: 'eBay' },
  { key: 'shopify', label: 'Shopify' },
]

export default function ImagesTab({ product, discardSignal, onDirtyChange, onPreSaveAll }: Props) {
  const [activeChannel, setActiveChannel] = useState<ChannelTab>('master')
  const [toast, setToast] = useState<string | null>(null)
  const [editorImage, setEditorImage] = useState<ProductImage | null>(null)
  const [damPickerOpen, setDamPickerOpen] = useState(false)
  const [lifestyleOpen, setLifestyleOpen] = useState(false)
  // PB.1 — global publish-dropdown state. Channel-panel publish buttons
  // still own their own status indicators; this state only guards the
  // top-level action bar's spinner.
  const [publishing, setPublishing] = useState(false)
  // PB.5 — Cross-channel summary modal.
  const [crossChannelOpen, setCrossChannelOpen] = useState(false)
  // PB.9 — Rollback modal state.
  const [rollbackTarget, setRollbackTarget] = useState<{ channel: SnapshotChannel; marketplace: string | null } | null>(null)
  // PB.10 — Schedule-publish modal state + pending count badge.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [pendingScheduleCount, setPendingScheduleCount] = useState(0)
  // PB.12 — Approval modal state + pending count badge.
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0)
  // PB.13 — bump to force the health cards to refetch after a publish.
  const [healthRefreshKey, setHealthRefreshKey] = useState(0)
  function refreshApprovalCount() {
    setPendingApprovalCount(readPendingApprovals(product.id).length)
  }
  useEffect(() => { refreshApprovalCount() }, [product.id])
  const lightbox = useLightbox()
  const { t } = useTranslations()

  const workspace = useImagesWorkspace(product.id, discardSignal, onDirtyChange)

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3000)
  }

  // PB.10 — Fetch pending schedule count once on mount + when the
  // operator changes the schedules from inside the modal.
  const fetchPendingScheduleCount = useCallback(async () => {
    try {
      const res = await beFetch(`/api/products/${product.id}/scheduled-image-publishes?status=PENDING`)
      if (!res.ok) return
      const body = await res.json() as { rows: unknown[] }
      setPendingScheduleCount(body.rows?.length ?? 0)
    } catch {
      // Non-fatal — badge just stays at zero.
    }
  }, [product.id])
  useEffect(() => { void fetchPendingScheduleCount() }, [fetchPendingScheduleCount])

  // These useMemo calls must stay above the early returns to satisfy Rules of Hooks.
  const listing  = workspace.data?.listing  ?? []
  const master   = workspace.data?.master   ?? []
  const variants = workspace.data?.variants ?? []
  const channelLiveImages = workspace.data?.channelLiveImages ?? []

  // IE.5 — Adopt a live channel image into the master gallery. Fetches
  // the live URL bytes, posts through the standard upload pipeline so
  // the IE.1 dedup gate runs and the new row picks up dimensions /
  // hashes / Cloudinary publicId like any other upload.
  async function handleAdoptToMaster(url: string): Promise<void> {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const fd = new FormData()
      fd.append('file', new File([blob], `live-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }))
      const up = await beFetch(`/api/products/${product.id}/images?type=LIFESTYLE`, {
        method: 'POST',
        body: fd,
      })
      if (!up.ok) throw new Error(`Adopt failed: ${up.status}`)
      showToast('Live image adopted into master gallery')
      void workspace.reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Adopt failed')
    }
  }

  const channelScores = useMemo(() => {
    const pending = Array.from(workspace.pendingUpserts.values())
    const amazonEffective = [...listing.filter((i) => i.platform === 'AMAZON'), ...pending.filter((u) => u.platform === 'AMAZON') as any[]]
    const ebayEffective   = [...listing.filter((i) => i.platform === 'EBAY'),   ...pending.filter((u) => u.platform === 'EBAY') as any[]]
    const shopifyEffective = [...listing.filter((i) => i.platform === 'SHOPIFY'), ...pending.filter((u) => u.platform === 'SHOPIFY') as any[]]

    function pct(checks: boolean[]) { return Math.round(checks.filter(Boolean).length / checks.length * 100) }

    const amazonChecks = [
      amazonEffective.some((i) => i.amazonSlot === 'MAIN') || master.length > 0,
      amazonEffective.some((i) => i.amazonSlot === 'MAIN' && i.hasWhiteBackground === true) || !amazonEffective.some((i) => i.amazonSlot === 'MAIN'),
      amazonEffective.some((i) => i.amazonSlot === 'SWCH') || variants.length === 0,
      variants.length === 0 || variants.every((v) => v.amazonAsin),
    ]

    const ebayGallery = ebayEffective.filter((i) => !i.variantGroupKey)
    const ebayChecks = [
      ebayGallery.length > 0 || master.length > 0,
      ebayGallery.length >= 3 || master.length >= 3,
      ebayEffective.some((i) => i.variantGroupKey) || variants.length === 0,
    ]

    const shopifyPool = shopifyEffective.filter((i) => !i.variantGroupKey)
    const shopifyChecks = [
      shopifyPool.length > 0 || master.length > 0,
      shopifyEffective.some((i) => i.variantGroupKey) || variants.length === 0,
      master.some((i) => i.type === 'MAIN'),
    ]

    return {
      amazon: pct(amazonChecks),
      ebay: pct(ebayChecks),
      shopify: pct(shopifyChecks),
    }
  }, [listing, master, variants, workspace.pendingUpserts])

  const publishedCount = useMemo(() => ({
    amazon: listing.filter((i) => i.platform === 'AMAZON' && i.publishStatus === 'PUBLISHED').length,
    ebay:   listing.filter((i) => i.platform === 'EBAY'   && i.publishStatus === 'PUBLISHED').length,
    shopify: listing.filter((i) => i.platform === 'SHOPIFY' && i.publishStatus === 'PUBLISHED').length,
  }), [listing])

  // PB.2 — "needs publish" rows per channel: anything other than
  // PUBLISHED (DRAFT, OUTDATED, ERROR). Surfaced as a pill on each
  // channel tab next to the completeness score. Click pill →
  // jumps to the channel's publish anchor (PB.2).
  const unpublishedCount = useMemo(() => ({
    amazon:  listing.filter((i) => i.platform === 'AMAZON'  && i.publishStatus !== 'PUBLISHED').length,
    ebay:    listing.filter((i) => i.platform === 'EBAY'    && i.publishStatus !== 'PUBLISHED').length,
    shopify: listing.filter((i) => i.platform === 'SHOPIFY' && i.publishStatus !== 'PUBLISHED').length,
  }), [listing])

  // PB.1 — Per-channel status for the global Publish dropdown in the
  // action bar. hasContent is true once any image exists at master OR
  // listing level (the publish resolver cascades from master, so a
  // master-only product can still publish). lastPublishedAt is the
  // most recent publishedAt across rows for that platform.
  const channelStatus = useMemo(() => {
    function maxPubAt(platform: 'AMAZON' | 'EBAY' | 'SHOPIFY'): string | null {
      const stamps = listing
        .filter((i) => i.platform === platform && i.publishedAt)
        .map((i) => i.publishedAt as string)
      if (stamps.length === 0) return null
      return stamps.reduce((a, b) => (a > b ? a : b))
    }
    function pendingFor(platform: 'AMAZON' | 'EBAY' | 'SHOPIFY'): number {
      const upserts = Array.from(workspace.pendingUpserts.values()).filter((u) => u.platform === platform).length
      const deletes = Array.from(workspace.pendingDeletes).filter((id) =>
        listing.some((l) => l.id === id && l.platform === platform),
      ).length
      return upserts + deletes
    }
    const masterExists = master.length > 0
    return {
      amazon: {
        hasContent: masterExists || listing.some((i) => i.platform === 'AMAZON'),
        pendingCount: pendingFor('AMAZON'),
        lastPublishedAt: maxPubAt('AMAZON'),
      },
      ebay: {
        hasContent: masterExists || listing.some((i) => i.platform === 'EBAY'),
        pendingCount: pendingFor('EBAY'),
        lastPublishedAt: maxPubAt('EBAY'),
      },
      shopify: {
        hasContent: masterExists || listing.some((i) => i.platform === 'SHOPIFY'),
        pendingCount: pendingFor('SHOPIFY'),
        lastPublishedAt: maxPubAt('SHOPIFY'),
      },
    }
  }, [listing, master, workspace.pendingUpserts, workspace.pendingDeletes])

  // Cmd+S to save pending changes from any channel tab.
  // Ref keeps the latest workspace state so the listener binds once.
  const saveRef = useRef<{ save: () => Promise<boolean>; dirty: number }>({
    save: workspace.savePending,
    dirty: workspace.dirtyCount,
  })
  useEffect(() => {
    saveRef.current = { save: workspace.savePending, dirty: workspace.dirtyCount }
  }, [workspace.savePending, workspace.dirtyCount])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) {
        // Let browser/inputs handle Cmd+S normally (textareas don't, but we
        // shouldn't hijack focus that's clearly typing-context).
        return
      }
      e.preventDefault()
      if (saveRef.current.dirty === 0) return
      void saveRef.current.save().then((ok) => {
        if (ok) showToast('Changes saved')
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Loading / error states ───────────────────────────────────────────
  if (workspace.loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading images…
      </div>
    )
  }

  if (workspace.loadError || !workspace.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <AlertTriangle className="w-6 h-6 text-amber-500" />
        <p className="text-sm">{workspace.loadError ?? 'Failed to load images'}</p>
        <Button size="sm" variant="ghost" onClick={workspace.reload} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </Button>
      </div>
    )
  }

  const { data, dirtyCount, saving, savePending, discardPending, setAxisPreference } = workspace
  const { product: wp, availableAxes } = data

  const activeAxis = wp.imageAxisPreference ?? availableAxes[0] ?? 'Color'

  // Pending channel images for the tab dot indicators
  const pendingForChannel = (channel: 'amazon' | 'ebay' | 'shopify') => {
    const platform = channel.toUpperCase()
    return Array.from(workspace.pendingUpserts.values()).filter(
      (u) => u.platform === platform,
    ).length
  }

  // PB.2 — Click-to-jump from a channel tab's "N to publish" pill.
  // Switches tab AND scrolls the channel's publish anchor into view
  // after the panel renders.
  function jumpToChannelPublish(channel: ChannelTab) {
    setActiveChannel(channel)
    // Wait one frame for the panel to mount, then a tick for layout.
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>('[data-publish-anchor]')
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'end' })
          el.classList.add('ring-2', 'ring-blue-400', 'rounded-xl')
          window.setTimeout(() => {
            el.classList.remove('ring-2', 'ring-blue-400', 'rounded-xl')
          }, 1600)
        }
      }, 80)
    })
  }

  // PB.1 / DSP.4 — Top-level publish handler used by ImageActionBar's
  // dropdown. Pre-save guarantee: every publish now flushes the
  // cross-tab dirty registry FIRST (onPreSaveAll, e.g. Master Data
  // edits) then the workspace-local pending changes (savePending).
  // Only after both saves succeed does the publish fire. Per-channel
  // publish panels delegate here so they get the same guarantee.
  async function handlePublish(target: PublishTarget, bypassApproval = false): Promise<void> {
    // PB.12 — Approval gate. If the per-product flag is set AND the
    // caller didn't bypass (approval modal does), queue the publish
    // instead of firing. Save is still attempted so pending changes
    // don't pile up; the approver sees the already-saved state when
    // they approve.
    if (!bypassApproval && isApprovalRequired(product.id)) {
      // DSP.4 — pre-save cross-tab dirty state too (Master Data etc.)
      // before queueing for approval, so the approver sees a fully
      // consistent snapshot.
      if (onPreSaveAll) {
        try {
          await onPreSaveAll()
        } catch (err) {
          showToast(`Save failed before approval: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
      }
      if (workspace.dirtyCount > 0) {
        const ok = await savePending()
        if (!ok) {
          showToast('Save failed — fix errors before queueing approval')
          return
        }
      }
      pushPendingApproval({ productId: product.id, target })
      refreshApprovalCount()
      const label = target.channel === 'AMAZON'
        ? (target.marketplace === 'ALL' ? 'all Amazon markets' : `Amazon ${target.marketplace}`)
        : target.channel === 'EBAY' ? 'eBay' : 'Shopify'
      showToast(`Queued for approval: publish to ${label}`)
      return
    }

    setPublishing(true)
    try {
      // DSP.4 — cross-tab pre-save first. If Master Data (or any
      // other registered tab) is dirty, this writes it before the
      // publish call so we never push stale data to a channel.
      if (onPreSaveAll) {
        try {
          await onPreSaveAll()
        } catch (err) {
          showToast(`Save failed before publishing: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
      }
      if (workspace.dirtyCount > 0) {
        const ok = await savePending()
        if (!ok) {
          showToast('Save failed — fix errors before publishing')
          return
        }
      }

      if (target.channel === 'AMAZON') {
        const markets = target.marketplace === 'ALL'
          ? (['IT', 'DE', 'FR', 'ES', 'UK'] as const)
          : [target.marketplace]
        let okCount = 0
        let skuTotal = 0
        for (const m of markets) {
          try {
            const res = await beFetch(`/api/products/${product.id}/amazon-images/publish`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ marketplace: m, activeAxis }),
            })
            const body = await res.json().catch(() => ({} as any))
            if (!res.ok) {
              showToast(`Amazon ${m}: ${body?.error ?? `publish failed (${res.status})`}`)
              continue
            }
            okCount++
            skuTotal += Array.isArray(body?.skus) ? body.skus.length : 0
            // PB.9 — Capture snapshot per market on success.
            captureSnapshot({ productId: product.id, channel: 'AMAZON', marketplace: m, listingImages: listing })
          } catch (err) {
            showToast(`Amazon ${m}: ${err instanceof Error ? err.message : 'publish failed'}`)
          }
        }
        if (okCount > 0) {
          showToast(`Amazon: queued ${skuTotal} SKU${skuTotal === 1 ? '' : 's'} across ${okCount} market${okCount === 1 ? '' : 's'}`)
        }
        void workspace.reload()
      } else if (target.channel === 'EBAY') {
        const res = await beFetch(`/api/products/${product.id}/ebay-images/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeAxis }),
        })
        const body = await res.json().catch(() => ({} as any))
        const success = res.ok && body?.success !== false
        if (success) {
          // PB.9 — Capture eBay snapshot on success.
          captureSnapshot({ productId: product.id, channel: 'EBAY', marketplace: null, listingImages: listing })
          // PB.15 — Browser notification.
          fireBrowserNotification('imagePublishComplete', 'eBay images published', {
            body: body?.message ?? `${product.sku ?? 'Product'} updated on eBay.`,
            tagSuffix: `ebay-${product.id}`,
          })
        } else {
          fireBrowserNotification('imagePublishFailed', 'eBay image publish failed', {
            body: body?.message ?? `HTTP ${res.status}`,
            tagSuffix: `ebay-${product.id}`,
          })
        }
        showToast(body?.message ?? (success ? 'Published to eBay' : `eBay publish failed (${res.status})`))
        void workspace.reload()
      } else if (target.channel === 'SHOPIFY') {
        const res = await beFetch(`/api/products/${product.id}/shopify-images/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeAxis }),
        })
        const body = await res.json().catch(() => ({} as any))
        const success = res.ok && body?.success !== false
        if (success) {
          // PB.9 — Capture Shopify snapshot on success.
          captureSnapshot({ productId: product.id, channel: 'SHOPIFY', marketplace: null, listingImages: listing })
          // PB.15 — Browser notification.
          fireBrowserNotification('imagePublishComplete', 'Shopify images published', {
            body: body?.message ?? `${product.sku ?? 'Product'} updated on Shopify.`,
            tagSuffix: `shopify-${product.id}`,
          })
        } else {
          fireBrowserNotification('imagePublishFailed', 'Shopify image publish failed', {
            body: body?.message ?? `HTTP ${res.status}`,
            tagSuffix: `shopify-${product.id}`,
          })
        }
        showToast(body?.message ?? (success ? 'Published to Shopify' : `Shopify publish failed (${res.status})`))
        void workspace.reload()
      }
      // PB.13 — Refetch the health-card stats after any publish path.
      setHealthRefreshKey((k) => k + 1)
    } finally {
      setPublishing(false)
    }
  }

  // IR.3.3 — open lightbox for a channel cell. listingImageId set → real
  // saved row; null → pending image, synthesize minimal LightboxImage.
  function openLightboxForListingCell(
    platform: 'AMAZON' | 'EBAY' | 'SHOPIFY',
    listingImageId: string | undefined,
    fallbackUrl: string,
  ) {
    if (listingImageId) {
      const li = listing.find((l) => l.id === listingImageId)
      if (li) {
        const siblings = listing.filter((l) => l.platform === platform).map(fromListing)
        lightbox.open(fromListing(li), siblings)
        return
      }
    }
    // Pending image — no saved row yet, no siblings list
    const synthetic: LightboxImage = {
      kind: 'listing',
      id: `pending-${fallbackUrl}`,
      url: fallbackUrl,
      platform,
    }
    lightbox.open(synthetic, [])
  }

  return (
    <div className="space-y-4">
      {/* ── Toast notification ──────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900 dark:bg-slate-100 text-slate-100 dark:text-slate-900 text-sm px-4 py-2 rounded-lg shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

      {/* PB.13 — Per-channel publish health cards */}
      <PublishHealthCards productId={product.id} refreshKey={healthRefreshKey} />

      {/* ── Channel tab strip + axis selector ───────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="flex items-center border-b border-slate-200 dark:border-slate-700 px-4 gap-1 flex-wrap">
          {/* Channel tabs */}
          <div className="flex items-center gap-1 flex-1 -mb-px overflow-x-auto">
            {CHANNEL_TABS.map(({ key, label }) => {
              const isActive = activeChannel === key
              const dotCount = key === 'master' ? 0 : pendingForChannel(key as any)
              const score = key === 'master' ? null : channelScores[key as keyof typeof channelScores]
              const pubCount = key === 'master' ? null : publishedCount[key as keyof typeof publishedCount]
              // PB.2 — count of ListingImage rows not yet PUBLISHED.
              const unpubCount = key === 'master' ? 0 : unpublishedCount[key as keyof typeof unpublishedCount]
              return (
                <div
                  key={key}
                  className={cn(
                    'relative flex items-center gap-1.5 border-b-2 transition-colors whitespace-nowrap',
                    isActive
                      ? 'border-blue-600 dark:border-blue-400'
                      : 'border-transparent hover:border-slate-300 dark:hover:border-slate-600',
                  )}
                >
                  {/* Tab label (selects tab) */}
                  <button
                    type="button"
                    onClick={() => setActiveChannel(key)}
                    className={cn(
                      'flex items-center gap-1.5 pl-4 py-3 text-sm font-medium',
                      isActive
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                    )}
                  >
                    {label}
                    {/* IM.10 — Completeness score pill */}
                    {score !== null && (
                      <span
                        className={cn(
                          'text-[10px] font-mono px-1.5 py-px rounded tabular-nums',
                          score >= 80
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                            : score >= 50
                              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                              : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300',
                        )}
                        title={`${score}% complete${pubCount ? ` · ${pubCount} published` : ''}`}
                      >
                        {score}%
                      </span>
                    )}
                  </button>

                  {/* PB.2 — Needs-publish pill. Click jumps to publish bar. */}
                  {unpubCount > 0 && (
                    <button
                      type="button"
                      onClick={() => jumpToChannelPublish(key)}
                      className="text-[10px] font-medium px-1.5 py-px rounded tabular-nums bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 inline-flex items-center gap-0.5"
                      title={`${unpubCount} not yet published — click to jump to publish`}
                    >
                      <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 9 L9 3 M5 3 L9 3 L9 7" />
                      </svg>
                      {unpubCount}
                    </button>
                  )}

                  {/* Unsaved-changes dot */}
                  {dotCount > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400" title={`${dotCount} unsaved`} />
                  )}

                  {/* Right-edge padding (stays inside the tab background) */}
                  <span className="pr-4 py-3" aria-hidden="true" />
                </div>
              )
            })}
          </div>

          {/* Axis selector — show whenever variants exist */}
          {variants.length > 0 && (
            <div className="flex items-center gap-2 py-2 pl-4 border-l border-slate-100 dark:border-slate-800 flex-shrink-0">
              <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">Group by</span>
              <input
                list="images-axis-list"
                value={activeAxis}
                onChange={(e) => { if (e.target.value.trim()) setAxisPreference(e.target.value.trim()) }}
                placeholder="e.g. Colore"
                className="text-xs border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-400 w-28"
              />
              <datalist id="images-axis-list">
                {[...new Set([...availableAxes, 'ASIN', 'SKU', 'Colore', 'Taglia', 'Color', 'Size', 'Colour', 'Material', 'Style', 'Gender'])].map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </div>
          )}
        </div>
      </div>

      {/* ── Panel + sidebar layout ───────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_220px] gap-4 items-start">
        {/* Active panel — min-w-0 so a wide channel matrix scrolls INSIDE its
            own overflow-x-auto container instead of widening the whole page. */}
        <div className="min-w-0">
          {activeChannel === 'master' && (
            <MasterPanel
              product={wp}
              images={master}
              listingImages={listing}
              variants={variants}
              activeAxis={activeAxis}
              availableAxes={availableAxes}
              addPendingUpsert={workspace.addPendingUpsert}
              // IA.12 — Optimistic: take the new array from MasterPanel
              // (reordered, appended, edited, deleted) and patch local
              // state directly. The master-image API endpoints have
              // already persisted by the time the callback fires;
              // skipping reload() removes the page-blink.
              onImagesChange={(next) => workspace.setMasterImages(() => next)}
              onAddToChannel={workspace.addToChannel}
              onToast={showToast}
              onOpenLightbox={(img) => lightbox.open(fromMaster(img), master.map(fromMaster))}
              onOpenDamPicker={() => setDamPickerOpen(true)}
              onOpenLifestyle={() => setLifestyleOpen(true)}
            />
          )}
          {activeChannel === 'amazon' && (
            <AmazonPanel
              productId={product.id}
              product={wp}
              masterImages={master}
              listingImages={listing}
              variants={variants}
              activeAxis={activeAxis}
              availableAxes={availableAxes}
              onAxisChange={setAxisPreference}
              pendingUpserts={workspace.pendingUpserts}
              addPendingUpsert={workspace.addPendingUpsert}
              removePendingUpsert={workspace.removePendingUpsert}
              amazonJobs={data.amazonJobs}
              dirtyCount={dirtyCount}
              onSavePending={savePending}
              onReload={workspace.reload}
              onToast={showToast}
              onOpenLightboxForCell={(id, url) => openLightboxForListingCell('AMAZON', id, url)}
              onCopyToEbayGallery={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyToEbayColorSets={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'colorSets', activeAxis })}
              onCopyToShopifyPool={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyToShopifyAssignments={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'colorSets', activeAxis })}
              channelLiveImages={channelLiveImages}
              onAdoptToMaster={(url) => handleAdoptToMaster(url)}
              addPendingDelete={workspace.addPendingDelete}
              pendingDeletes={workspace.pendingDeletes}
              restorePending={workspace.restorePending}
              onPublishSuccess={(marketplace) => {
                captureSnapshot({ productId: product.id, channel: 'AMAZON', marketplace, listingImages: listing })
              }}
              onOpenRollback={(marketplace) => setRollbackTarget({ channel: 'AMAZON', marketplace })}
            />
          )}
          {activeChannel === 'ebay' && (
            <EbayPanel
              productId={product.id}
              product={wp}
              masterImages={master}
              listingImages={listing}
              variants={variants}
              activeAxis={activeAxis}
              pendingUpserts={workspace.pendingUpserts}
              pendingDeletes={workspace.pendingDeletes}
              addPendingUpsert={workspace.addPendingUpsert}
              addPendingDelete={workspace.addPendingDelete}
              onToast={showToast}
              onOpenLightboxForCell={(id, url) => openLightboxForListingCell('EBAY', id, url)}
              onCopyFromMaster={() => workspace.copyChannelImages({ fromPlatform: 'MASTER', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyFromAmazonGallery={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyFromAmazonColorSets={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'colorSets', activeAxis })}
              publishedCount={publishedCount.ebay}
              onPublish={async () => {
                const ok = await savePending()
                if (!ok) {
                  showToast('Save failed — fix errors before publishing')
                  return { success: false, message: 'Save failed — fix errors first' }
                }
                const res = await beFetch(`/api/products/${product.id}/ebay-images/publish`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ activeAxis }),
                })
                const body = await res.json()
                const message = body.message ?? (res.ok ? 'Published to eBay' : 'eBay publish failed')
                if (res.ok && body.success !== false) {
                  // PB.9 — capture snapshot on success (panel-side publish path).
                  captureSnapshot({ productId: product.id, channel: 'EBAY', marketplace: null, listingImages: listing })
                }
                showToast(message)
                return { success: res.ok && body.success !== false, message }
              }}
              channelLiveImages={channelLiveImages}
              onReload={workspace.reload}
              onAdoptToMaster={(url) => handleAdoptToMaster(url)}
              onOpenRollback={() => setRollbackTarget({ channel: 'EBAY', marketplace: null })}
            />
          )}
          {activeChannel === 'shopify' && (
            <ShopifyPanel
              productId={product.id}
              product={wp}
              masterImages={master}
              listingImages={listing}
              variants={variants}
              activeAxis={activeAxis}
              pendingUpserts={workspace.pendingUpserts}
              pendingDeletes={workspace.pendingDeletes}
              addPendingUpsert={workspace.addPendingUpsert}
              addPendingDelete={workspace.addPendingDelete}
              onToast={showToast}
              onOpenLightboxForCell={(id, url) => openLightboxForListingCell('SHOPIFY', id, url)}
              onCopyFromMaster={() => workspace.copyChannelImages({ fromPlatform: 'MASTER', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyFromAmazonPool={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyFromAmazonAssignments={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'colorSets', activeAxis })}
              publishedCount={publishedCount.shopify}
              onPublish={async () => {
                const ok = await savePending()
                if (!ok) {
                  showToast('Save failed — fix errors before publishing')
                  return { success: false, message: 'Save failed — fix errors first' }
                }
                const res = await beFetch(`/api/products/${product.id}/shopify-images/publish`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ activeAxis }),
                })
                const body = await res.json()
                const message = body.message ?? (res.ok ? 'Published to Shopify' : 'Shopify publish failed')
                if (res.ok && body.success !== false) {
                  captureSnapshot({ productId: product.id, channel: 'SHOPIFY', marketplace: null, listingImages: listing })
                }
                showToast(message)
                return { success: res.ok && body.success !== false, message }
              }}
              channelLiveImages={channelLiveImages}
              onReload={workspace.reload}
              onAdoptToMaster={(url) => handleAdoptToMaster(url)}
              onOpenRollback={() => setRollbackTarget({ channel: 'SHOPIFY', marketplace: null })}
            />
          )}
        </div>

        {/* Quality checklist sidebar */}
        <div className="xl:sticky xl:top-24">
          <QualityChecklist
            product={wp}
            masterImages={master}
            listingImages={listing}
            variants={variants}
          />
        </div>
      </div>

      {/* PB.16 — Image-publish audit log */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <PublishAuditLog productId={product.id} refreshKey={healthRefreshKey} />
      </div>

      {/* ── Action bar ───────────────────────────────────────────────── */}
      <ImageActionBar
        productId={product.id}
        dirtyCount={dirtyCount}
        saving={saving}
        publishing={publishing}
        channelStatus={channelStatus}
        onSave={async () => {
          // PB.11 — Snapshot which channels were dirty BEFORE save,
          // so we can fire auto-publish for them after save succeeds.
          const dirtyChannels = new Set<AutoPublishChannel>()
          for (const u of workspace.pendingUpserts.values()) {
            if (u.platform === 'AMAZON' || u.platform === 'EBAY' || u.platform === 'SHOPIFY') {
              dirtyChannels.add(u.platform)
            }
          }
          for (const id of workspace.pendingDeletes) {
            const li = listing.find((l) => l.id === id)
            if (li?.platform === 'AMAZON' || li?.platform === 'EBAY' || li?.platform === 'SHOPIFY') {
              dirtyChannels.add(li.platform)
            }
          }
          const ok = await savePending()
          if (!ok) return
          showToast(t('products.edit.images.toasts.changesSaved'))
          // Auto-publish dispatch — sequential to keep error reporting clear.
          const prefs = readAllPrefs(product.id)
          for (const c of dirtyChannels) {
            if (!prefs[c]) continue
            try {
              await handlePublish(
                c === 'AMAZON'
                  ? { channel: 'AMAZON', marketplace: 'ALL' }
                  : { channel: c },
              )
            } catch {
              // handlePublish surfaces toasts internally; swallow here.
            }
          }
        }}
        onDiscard={() => {
          discardPending()
          showToast(t('products.edit.images.toasts.changesDiscarded'))
        }}
        onPublish={handlePublish}
        onOpenCrossChannel={() => setCrossChannelOpen(true)}
        onOpenSchedule={() => setScheduleOpen(true)}
        pendingScheduleCount={pendingScheduleCount}
        autoPublishSlot={
          <AutoPublishSettings
            productId={product.id}
            availableChannels={[
              ...(channelStatus.amazon.hasContent ? (['AMAZON'] as const) : []),
              ...(channelStatus.ebay.hasContent ? (['EBAY'] as const) : []),
              ...(channelStatus.shopify.hasContent ? (['SHOPIFY'] as const) : []),
            ]}
            onChanged={refreshApprovalCount}
          />
        }
        onOpenApprovals={() => setApprovalOpen(true)}
        pendingApprovalCount={pendingApprovalCount}
      />

      {/* PB.12 — Approval queue modal */}
      <ApprovalModal
        open={approvalOpen}
        productId={product.id}
        onPublish={async (target) => {
          // bypass=true so the approval gate doesn't re-queue.
          await handlePublish(target, true)
        }}
        onToast={showToast}
        onClose={() => setApprovalOpen(false)}
        onChanged={refreshApprovalCount}
      />

      {/* PB.10 — Schedule publish modal */}
      <SchedulePublishModal
        open={scheduleOpen}
        productId={product.id}
        onClose={() => setScheduleOpen(false)}
        onChanged={() => { void fetchPendingScheduleCount() }}
      />

      {/* PB.9 — Rollback to last published snapshot */}
      {rollbackTarget && (
        <RollbackModal
          open
          productId={product.id}
          channel={rollbackTarget.channel}
          marketplace={rollbackTarget.marketplace}
          listingImages={listing}
          addPendingUpsert={workspace.addPendingUpsert}
          onToast={showToast}
          onClose={() => setRollbackTarget(null)}
        />
      )}

      {/* PB.5 — Cross-channel publish summary modal */}
      <CrossChannelPublishModal
        open={crossChannelOpen}
        productId={product.id}
        masterImages={master}
        listingImages={listing}
        pendingUpserts={workspace.pendingUpserts}
        pendingDeletes={workspace.pendingDeletes}
        variants={variants}
        activeAxis={activeAxis}
        onClose={() => setCrossChannelOpen(false)}
        onPublishChannel={async (target) => {
          await handlePublish(target)
        }}
      />

      {/* ── Lightbox modal (IR.3) ────────────────────────────────────── */}
      {lightbox.state && (
        <LightboxModal
          state={lightbox.state}
          masterImages={master}
          listingImages={listing}
          damLinks={data.damLinks ?? {}}
          productId={product.id}
          onMasterImageUpdated={() => { void workspace.reload() }}
          onEditMaster={(img) => setEditorImage(img)}
          onSwitchToMaster={(img) => lightbox.open(fromMaster(img), master.map(fromMaster))}
          onPushToDam={() => { void workspace.reload(); showToast(t('products.edit.images.toasts.pushedToDam')) }}
          onClose={lightbox.close}
          onNavigate={lightbox.navigate}
        />
      )}

      {/* ── Image editor modal (IR.4) ────────────────────────────────── */}
      {editorImage && (
        <ImageEditorModal
          productId={product.id}
          image={editorImage}
          onClose={() => setEditorImage(null)}
          onSaved={() => {
            setEditorImage(null)
            lightbox.close()
            showToast(t('products.edit.images.toasts.derivativeSaved'))
            void workspace.reload()
          }}
        />
      )}

      {/* ── DAM library picker (IR.7 + IE.7 scope chips) ─────────────── */}
      {damPickerOpen && (
        <DamPickerModal
          productId={product.id}
          productBrand={wp.brand}
          productProductType={wp.productType}
          onClose={() => setDamPickerOpen(false)}
          onImported={() => {
            showToast(t('products.edit.images.toasts.importedFromDam'))
            void workspace.reload()
          }}
        />
      )}

      {/* ── Imagen lifestyle generation (IR.14) ────────────────────────── */}
      {lifestyleOpen && (
        <LifestyleGenerationModal
          productId={product.id}
          onClose={() => setLifestyleOpen(false)}
          onGenerated={() => {
            setLifestyleOpen(false)
            showToast(t('products.edit.images.toasts.lifestyleGenerated'))
            void workspace.reload()
          }}
        />
      )}
    </div>
  )
}
