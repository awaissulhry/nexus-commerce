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

import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { beFetch } from './images/api'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { useImagesWorkspace } from './images/useImagesWorkspace'
import MasterPanel from './images/MasterPanel'
import QualityChecklist from './images/QualityChecklist'
import ImageActionBar from './images/ImageActionBar'
import AmazonPanel from './images/amazon/AmazonPanel'
import EbayPanel from './images/ebay/EbayPanel'
import ShopifyPanel from './images/shopify/ShopifyPanel'
import type { ChannelTab } from './images/types'

interface Props {
  product: { id: string; sku: string }
  discardSignal: number
  onDirtyChange: (count: number) => void
}

const CHANNEL_TABS: { key: ChannelTab; label: string }[] = [
  { key: 'master',  label: 'Master' },
  { key: 'amazon',  label: 'Amazon' },
  { key: 'ebay',    label: 'eBay' },
  { key: 'shopify', label: 'Shopify' },
]

export default function ImagesTab({ product, discardSignal, onDirtyChange }: Props) {
  const [activeChannel, setActiveChannel] = useState<ChannelTab>('master')
  const [toast, setToast] = useState<string | null>(null)

  const workspace = useImagesWorkspace(product.id, discardSignal, onDirtyChange)

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3000)
  }

  // These useMemo calls must stay above the early returns to satisfy Rules of Hooks.
  const listing  = workspace.data?.listing  ?? []
  const master   = workspace.data?.master   ?? []
  const variants = workspace.data?.variants ?? []

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

  return (
    <div className="space-y-4">
      {/* ── Toast notification ──────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900 dark:bg-slate-100 text-slate-100 dark:text-slate-900 text-sm px-4 py-2 rounded-lg shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

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
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveChannel(key)}
                  className={cn(
                    'relative flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                    isActive
                      ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:border-slate-300 dark:hover:border-slate-600',
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
                  {dotCount > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400" title={`${dotCount} unsaved`} />
                  )}
                </button>
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
                {[...new Set([...availableAxes, 'Colore', 'Taglia', 'Color', 'Size', 'Colour', 'Material', 'Style', 'Gender'])].map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </div>
          )}
        </div>
      </div>

      {/* ── Panel + sidebar layout ───────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_220px] gap-4 items-start">
        {/* Active panel */}
        <div>
          {activeChannel === 'master' && (
            <MasterPanel
              product={wp}
              images={master}
              onImagesChange={() => { void workspace.reload() }}
              onAddToChannel={workspace.addToChannel}
              onToast={showToast}
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
              onCopyToEbayGallery={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyToEbayColorSets={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'colorSets', activeAxis })}
              onCopyToShopifyPool={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyToShopifyAssignments={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'colorSets', activeAxis })}
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
              onCopyFromMaster={() => workspace.copyChannelImages({ fromPlatform: 'MASTER', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyFromAmazonGallery={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'gallery', activeAxis })}
              onCopyFromAmazonColorSets={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'EBAY', type: 'colorSets', activeAxis })}
              publishedCount={publishedCount.ebay}
              onPublish={async () => {
                const ok = await savePending()
                if (!ok) { showToast('Save failed — fix errors before publishing'); return }
                const res = await beFetch(`/api/products/${product.id}/ebay-images/publish`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ activeAxis }),
                })
                const data = await res.json()
                showToast(data.message ?? (data.success ? 'Published to eBay' : 'eBay publish failed'))
              }}
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
              onCopyFromMaster={() => workspace.copyChannelImages({ fromPlatform: 'MASTER', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyFromAmazonPool={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'gallery', activeAxis })}
              onCopyFromAmazonAssignments={() => workspace.copyChannelImages({ fromPlatform: 'AMAZON', toPlatform: 'SHOPIFY', type: 'colorSets', activeAxis })}
              publishedCount={publishedCount.shopify}
              onPublish={async () => {
                const ok = await savePending()
                if (!ok) { showToast('Save failed — fix errors before publishing'); return }
                const res = await beFetch(`/api/products/${product.id}/shopify-images/publish`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ activeAxis }),
                })
                const data = await res.json()
                showToast(data.message ?? (data.success ? 'Published to Shopify' : 'Shopify publish failed'))
              }}
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

      {/* ── Action bar ───────────────────────────────────────────────── */}
      <ImageActionBar
        activeChannel={activeChannel}
        dirtyCount={dirtyCount}
        saving={saving}
        onSave={async () => {
          const ok = await savePending()
          if (ok) showToast('Changes saved')
        }}
        onDiscard={() => {
          discardPending()
          showToast('Changes discarded')
        }}
      />
    </div>
  )
}
