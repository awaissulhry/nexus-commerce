'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  TableProperties,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import ListOnChannelDropdown from './ListOnChannelDropdown'
import MasterDataTab from './tabs/MasterDataTab'
import PricingTab from './tabs/PricingTab'
import ActivityTab from './tabs/ActivityTab'
import WorkflowTab from './tabs/WorkflowTab'
import RelationsTab from './tabs/RelationsTab'
import InventoryTab from './tabs/InventoryTab'
import VariationsTab from './tabs/VariationsTab'
import ChannelListingTab from './tabs/ChannelListingTab'
import { cn } from '@/lib/utils'
import { useTrackRecentlyViewed } from '@/lib/use-recently-viewed'

type TopTab = 'master' | 'variations' | string // also "AMAZON" / "EBAY" / "SHOPIFY_GLOBAL" etc

interface Marketplace {
  code: string
  name: string
  channel: string
  marketplaceId?: string | null
  region: string
  currency: string
  language: string
  domainUrl?: string | null
}

interface Listing {
  id: string
  channel: string
  marketplace: string
  channelMarket: string
  region: string
  title: string | null
  description: string | null
  price: string | number | null
  quantity: number | null
  isPublished: boolean
  listingStatus: string
  externalListingId: string | null
  bulletPointsOverride: string[] | null
  [key: string]: any
}

interface Props {
  product: any
  listings: Record<string, Listing[]>
  marketplaces: Record<string, Marketplace[]>
  childrenList: any[]
}

const SINGLE_STORE_CHANNELS = new Set(['SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']

const LABEL_CASE: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

export default function ProductEditClient({
  product,
  listings,
  marketplaces,
  childrenList,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslations()
  const confirm = useConfirm()
  // U.30 — read initial tab from `?tab=<x>`. HierarchyLens deep-links
  // to /products/${id}/edit?tab=variations; pre-fix the link silently
  // landed on master.
  const [topTab, setTopTab] = useState<TopTab>(() => {
    const initial = searchParams?.get('tab')
    return (initial as TopTab) || 'master'
  })
  // Per-channel selected marketplace (key by channel)
  const [marketSelection, setMarketSelection] = useState<Record<string, string>>({})

  // W1.1 — accurate dirty tracking. Each tab reports its own count of
  // unsaved fields via onDirtyChange; the header badge shows the
  // aggregate. Replaces the old single boolean which never cleared
  // after the first edit (B1) and made "Discard" a lie because there
  // was no signal to actually revert tab state (B2).
  const [dirtyByTab, setDirtyByTab] = useState<Record<string, number>>({})
  const totalDirty = useMemo(
    () => Object.values(dirtyByTab).reduce((a, b) => a + b, 0),
    [dirtyByTab],
  )
  const isDirty = totalDirty > 0
  const setTabDirty = useCallback((tabKey: string, count: number) => {
    setDirtyByTab((prev) => (prev[tabKey] === count ? prev : { ...prev, [tabKey]: count }))
  }, [])
  // Bumped by Discard. Tabs watch this prop; on change they cancel
  // pending debounce timers, drop their dirty set, and reseed values
  // from the freshly-fetched product. Channel tabs additionally hard-
  // remount via key so any in-progress side-effects unwind cleanly.
  const [discardSignal, setDiscardSignal] = useState(0)
  const [showCreatedBanner, setShowCreatedBanner] = useState(
    () => searchParams?.get('created') === '1',
  )

  // NN.3 — beforeunload guard so closing the tab / hitting back
  // doesn't silently drop unsaved edits.
  useEffect(() => {
    if (!isDirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  useTrackRecentlyViewed({
    id: product.id,
    label: product.sku,
    href: `/products/${product.id}/edit`,
    type: 'product',
  })

  const handleDiscard = async () => {
    if (!isDirty) {
      router.refresh()
      return
    }
    const ok = await confirm({
      title:
        totalDirty === 1
          ? t('products.edit.discardConfirmOne')
          : t('products.edit.discardConfirmMany', { count: totalDirty }),
      description: t('products.edit.discardBody'),
      confirmLabel: t('products.edit.discardCta'),
      tone: 'warning',
    })
    if (!ok) return
    setDiscardSignal((s) => s + 1)
    setDirtyByTab({})
    router.refresh()
  }

  const orderedChannels = CHANNEL_ORDER.filter((c) => marketplaces[c]?.length)

  const hasListing = (channel: string, marketplace: string) =>
    listings[channel]?.some((l) => l.marketplace === marketplace) ?? false

  const getListing = (channel: string, marketplace: string) =>
    listings[channel]?.find((l) => l.marketplace === marketplace)

  const ensureMarketSelected = (channel: string): string => {
    const existing = marketSelection[channel]
    if (existing) return existing
    const channelMarkets = marketplaces[channel] ?? []
    const firstWithListing = channelMarkets.find((m) =>
      hasListing(channel, m.code)
    )
    const fallback = firstWithListing?.code ?? channelMarkets[0]?.code ?? 'GLOBAL'
    setMarketSelection((s) => ({ ...s, [channel]: fallback }))
    return fallback
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <IconButton
              onClick={() => router.push('/products')}
              aria-label={t('products.edit.back')}
              size="md"
              className="-m-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <ChevronLeft className="w-4 h-4" />
            </IconButton>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate max-w-[480px]">
                  {product.name}
                </h1>
                {product.isParent && (
                  <Badge variant="info">
                    {t('products.edit.variantsBadge', { count: childrenList.length })}
                  </Badge>
                )}
                {isDirty && (
                  <Badge variant="warning">
                    <AlertCircle className="w-3 h-3" />
                    {totalDirty === 1
                      ? t('products.edit.unsaved')
                      : t('products.edit.unsavedCount', { count: totalDirty })}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                <span>{product.sku}</span>
                {product.amazonAsin && <span>{product.amazonAsin}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/products/${product.id}/edit/bulk`)}
              title={t('products.edit.bulkEditTooltip')}
            >
              <TableProperties className="w-3.5 h-3.5 mr-1.5" />
              {t('products.edit.bulkEdit')}
            </Button>
            <ListOnChannelDropdown productId={product.id} />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              title={
                isDirty
                  ? t('products.edit.discardCta')
                  : t('products.edit.discardEmpty')
              }
            >
              {t('products.edit.discard')}
            </Button>
          </div>
        </div>

        {/* ── Top tab row ────────────────────────────────────── */}
        <div className="max-w-7xl mx-auto px-6">
          <div
            role="tablist"
            aria-label="Product sections"
            className="flex items-center -mb-px overflow-x-auto"
          >
            <TopTabButton
              active={topTab === 'master'}
              onClick={() => setTopTab('master')}
            >
              {t('products.edit.tab.master')}
            </TopTabButton>
            <TopTabButton
              active={topTab === 'pricing'}
              onClick={() => setTopTab('pricing')}
            >
              {t('products.edit.tab.pricing')}
            </TopTabButton>
            <TopTabButton
              active={topTab === 'inventory'}
              onClick={() => setTopTab('inventory')}
            >
              {t('products.edit.tab.inventory')}
            </TopTabButton>
            <TopTabButton
              active={topTab === 'workflow'}
              onClick={() => setTopTab('workflow')}
            >
              {t('products.edit.tab.workflow')}
            </TopTabButton>
            <TopTabButton
              active={topTab === 'relations'}
              onClick={() => setTopTab('relations')}
            >
              {t('products.edit.tab.relations')}
            </TopTabButton>
            <TopTabButton
              active={topTab === 'activity'}
              onClick={() => setTopTab('activity')}
            >
              {t('products.edit.tab.activity')}
            </TopTabButton>
            {product.isParent && (
              <TopTabButton
                active={topTab === 'variations'}
                onClick={() => setTopTab('variations')}
                count={childrenList.length}
              >
                {t('products.edit.tab.variations')}
              </TopTabButton>
            )}
            {orderedChannels.map((channel) => {
              const isActive = topTab === channel
              const channelListings = listings[channel] ?? []
              return (
                <TopTabButton
                  key={channel}
                  active={isActive}
                  onClick={() => {
                    if (SINGLE_STORE_CHANNELS.has(channel)) {
                      setMarketSelection((s) => ({ ...s, [channel]: 'GLOBAL' }))
                    } else {
                      ensureMarketSelected(channel)
                    }
                    setTopTab(channel)
                  }}
                  count={channelListings.length || undefined}
                >
                  {LABEL_CASE[channel] ?? channel}
                </TopTabButton>
              )
            })}
          </div>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* PP — post-create bridge banner */}
        {showCreatedBanner && (
          <div className="mb-4 border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 rounded-lg px-4 py-3 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-md font-semibold text-emerald-900 dark:text-emerald-200">
                  {t('products.edit.createdBanner.title', { sku: product.sku })}
                </div>
                <div className="text-sm text-emerald-800 dark:text-emerald-300 mt-0.5">
                  {t('products.edit.createdBanner.body')}
                </div>
              </div>
            </div>
            <IconButton
              onClick={() => setShowCreatedBanner(false)}
              aria-label={t('products.edit.createdBanner.dismiss')}
              size="sm"
              className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-200 flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        )}
        {topTab === 'master' && (
          <MasterDataTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('master', count)}
          />
        )}

        {topTab === 'pricing' && (
          <PricingTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('pricing', count)}
          />
        )}

        {topTab === 'inventory' && (
          <InventoryTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('inventory', count)}
          />
        )}

        {topTab === 'workflow' && (
          <WorkflowTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('workflow', count)}
          />
        )}

        {topTab === 'relations' && (
          <RelationsTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('relations', count)}
          />
        )}

        {topTab === 'activity' && (
          <ActivityTab
            product={product}
            discardSignal={discardSignal}
            onDirtyChange={(count) => setTabDirty('activity', count)}
          />
        )}

        {topTab === 'variations' && product.isParent && (
          <VariationsTab parent={product} childrenList={childrenList} />
        )}

        {orderedChannels.includes(topTab) && (() => {
          const channel = topTab
          const isSingleStore = SINGLE_STORE_CHANNELS.has(channel)
          const channelMarkets = marketplaces[channel] ?? []
          const selectedMarket = marketSelection[channel] ?? channelMarkets[0]?.code ?? 'GLOBAL'
          const marketInfo = channelMarkets.find((m) => m.code === selectedMarket)
          const listing = marketInfo ? getListing(channel, marketInfo.code) : undefined

          if (!marketInfo) {
            return (
              <div className="text-md text-slate-500 dark:text-slate-400">
                {t('products.edit.noMarkets', { channel })}
              </div>
            )
          }

          const tabKey = `channel:${channel}:${selectedMarket}`
          return (
            <div className={cn('grid gap-6', !isSingleStore && 'grid-cols-[200px_1fr]')}>
              {!isSingleStore && (
                <MarketplaceSidebar
                  channel={channel}
                  marketplaces={channelMarkets}
                  selected={selectedMarket}
                  hasListing={hasListing}
                  onSelect={(code) =>
                    setMarketSelection((s) => ({ ...s, [channel]: code }))
                  }
                />
              )}
              <ChannelListingTab
                /* W1.1 — discardSignal in the key forces a fresh remount
                 * when the user discards: cleanup effects fire, debounce
                 * timers cancel, and the editor reseeds from server data
                 * via its own fetch chain. */
                key={`${channel}_${selectedMarket}_${discardSignal}`}
                product={product}
                channel={channel}
                marketplace={selectedMarket}
                marketInfo={marketInfo}
                listing={listing}
                onDirtyChange={(count) => setTabDirty(tabKey, count)}
                onSave={() => router.refresh()}
              />
            </div>
          )
        })()}
      </main>
    </div>
  )
}

function TopTabButton({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 h-10 px-4 text-md font-medium border-b-2 transition-colors whitespace-nowrap',
        active
          ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded text-xs tabular-nums px-1.5 py-0.5 min-w-[18px]',
            active
              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function MarketplaceSidebar({
  channel,
  marketplaces,
  selected,
  hasListing,
  onSelect,
}: {
  channel: string
  marketplaces: Marketplace[]
  selected: string
  hasListing: (channel: string, marketplace: string) => boolean
  onSelect: (code: string) => void
}) {
  const { t } = useTranslations()
  return (
    <aside className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden h-fit sticky top-[7.5rem]">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
          {t('products.edit.markets')}
        </h3>
      </div>
      <ul className="py-1">
        {marketplaces.map((m) => {
          const active = m.code === selected
          const listed = hasListing(channel, m.code)
          return (
            <li key={m.code}>
              <button
                onClick={() => onSelect(m.code)}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-3 py-1.5 text-md text-left transition-colors',
                  active
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                )}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      'font-mono text-xs tabular-nums px-1.5 py-0.5 rounded border',
                      active
                        ? 'bg-white dark:bg-slate-900 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                        : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    )}
                  >
                    {m.code}
                  </span>
                  <span className="truncate">{m.name.replace(/^(Amazon|eBay)\s+/, '')}</span>
                </span>
                <span
                  className={cn(
                    'flex-shrink-0 w-1.5 h-1.5 rounded-full',
                    listed ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'
                  )}
                  title={listed ? t('products.edit.listingExists') : t('products.edit.notListed')}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
