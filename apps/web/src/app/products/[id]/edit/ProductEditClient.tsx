'use client'

import { useEffect, useState } from 'react'
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
import ListOnChannelDropdown from './ListOnChannelDropdown'
import MasterDataTab from './tabs/MasterDataTab'
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
  const [topTab, setTopTab] = useState<TopTab>('master')
  // Per-channel selected marketplace (key by channel)
  const [marketSelection, setMarketSelection] = useState<Record<string, string>>({})
  const [unsavedChanges, setUnsavedChanges] = useState(false)
  // PP — bridge banner from /products/new. The wizard redirects with
  // ?created=1; we show a one-time success card with a "List on
  // channel" CTA so the user can flow straight into the existing
  // listing wizard without hunting for the dropdown.
  const [showCreatedBanner, setShowCreatedBanner] = useState(
    () => searchParams?.get('created') === '1',
  )

  // NN.3 — beforeunload guard so closing the tab / hitting back
  // doesn't silently drop unsaved edits. Only attached when the
  // dirty flag is set so users without pending changes don't see
  // the browser's "Leave site?" prompt every navigation.
  useEffect(() => {
    if (!unsavedChanges) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      // Most browsers ignore the custom message and show their own
      // localized prompt; we set returnValue for older Safari.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsavedChanges])

  // Push this product onto the sidebar's "Recently viewed" list
  useTrackRecentlyViewed({
    id: product.id,
    label: product.sku,
    href: `/products/${product.id}/edit`,
    type: 'product',
  })

  const orderedChannels = CHANNEL_ORDER.filter((c) => marketplaces[c]?.length)

  const hasListing = (channel: string, marketplace: string) =>
    listings[channel]?.some((l) => l.marketplace === marketplace) ?? false

  const getListing = (channel: string, marketplace: string) =>
    listings[channel]?.find((l) => l.marketplace === marketplace)

  // When switching to a channel, default-select the first marketplace that
  // already has a listing, otherwise the first available one.
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
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.push('/products')}
              className="p-1 -m-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900"
              aria-label="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-semibold text-slate-900 truncate max-w-[480px]">
                  {product.name}
                </h1>
                {product.isParent && (
                  <Badge variant="info">{childrenList.length} variants</Badge>
                )}
                {unsavedChanges && (
                  <Badge variant="warning">
                    <AlertCircle className="w-3 h-3" />
                    Unsaved
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-slate-500 mt-0.5 font-mono">
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
              title="Open the spreadsheet view to edit master fields across this product and its variants"
            >
              <TableProperties className="w-3.5 h-3.5 mr-1.5" />
              Bulk edit
            </Button>
            <ListOnChannelDropdown productId={product.id} />
            <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
              Discard
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
              Master Data
            </TopTabButton>
            {product.isParent && (
              <TopTabButton
                active={topTab === 'variations'}
                onClick={() => setTopTab('variations')}
                count={childrenList.length}
              >
                Variations
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
        {/* PP — post-create bridge banner. Surfaces immediately after
            the create wizard redirects here so the user can hop into
            the listing wizard without hunting for the dropdown. */}
        {showCreatedBanner && (
          <div className="mb-4 border border-emerald-200 bg-emerald-50 rounded-lg px-4 py-3 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-md font-semibold text-emerald-900">
                  {product.sku} created
                </div>
                <div className="text-sm text-emerald-800 mt-0.5">
                  Master data is saved. Use the <strong>List on Channel</strong>{' '}
                  dropdown above to publish to Amazon, eBay, Shopify or
                  WooCommerce — the wizard handles per-channel attributes,
                  pricing and submit.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowCreatedBanner(false)}
              className="text-emerald-600 hover:text-emerald-900 flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {topTab === 'master' && (
          <MasterDataTab product={product} onChange={() => setUnsavedChanges(true)} />
        )}

        {topTab === 'variations' && product.isParent && (
          <VariationsTab
            parent={product}
            childrenList={childrenList}
            onChange={() => setUnsavedChanges(true)}
          />
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
              <div className="text-md text-slate-500">
                No marketplaces configured for {channel}.
              </div>
            )
          }

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
                key={`${channel}_${selectedMarket}`}
                product={product}
                channel={channel}
                marketplace={selectedMarket}
                marketInfo={marketInfo}
                listing={listing}
                onChange={() => setUnsavedChanges(true)}
                onSave={() => {
                  setUnsavedChanges(false)
                  router.refresh()
                }}
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
  // NN.15 — accessibility. role=tab + aria-selected pairs with the
  // wrapping nav's role=tablist (added on the parent container) so
  // screen readers announce 'tab N of M, selected'.
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
          ? 'border-blue-600 text-blue-600'
          : 'border-transparent text-slate-600 hover:text-slate-900'
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded text-xs tabular-nums px-1.5 py-0.5 min-w-[18px]',
            active ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
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
  return (
    <aside className="bg-white border border-slate-200 rounded-lg overflow-hidden h-fit sticky top-[7.5rem]">
      <div className="px-3 py-2 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">
          Markets
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
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-700 hover:bg-slate-50'
                )}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      'font-mono text-xs tabular-nums px-1.5 py-0.5 rounded border',
                      active
                        ? 'bg-white border-blue-200 text-blue-700'
                        : 'bg-slate-100 border-slate-200 text-slate-600'
                    )}
                  >
                    {m.code}
                  </span>
                  <span className="truncate">{m.name.replace(/^(Amazon|eBay)\s+/, '')}</span>
                </span>
                <span
                  className={cn(
                    'flex-shrink-0 w-1.5 h-1.5 rounded-full',
                    listed ? 'bg-green-500' : 'bg-slate-300'
                  )}
                  title={listed ? 'Listing exists' : 'Not listed'}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
