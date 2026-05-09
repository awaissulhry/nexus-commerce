'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  FileText,
  LayoutGrid,
  LifeBuoy,
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
import LocalesTab from './tabs/LocalesTab'
import VariationsTab from './tabs/VariationsTab'
import ChannelListingTab from './tabs/ChannelListingTab'
import ComplianceTab from './tabs/ComplianceTab'
import ImagesTab from './tabs/ImagesTab'
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

/** W5.1 — channel readiness scoring (Salsify cornerstone).
 *
 *  Five top-level dimensions per listing, 20% each:
 *    - title (non-empty string)
 *    - description (non-empty string)
 *    - bullets (≥3 entries)
 *    - price (positive number)
 *    - quantity (≥0 integer; 0 is acceptable for sold-out / pre-order)
 *
 *  Schema-driven attributes (platformAttributes.attributes) aren't
 *  scored here yet — that's a W5.2 concern that needs the per-channel
 *  required-fields schema. This baseline already separates "blank"
 *  from "ready to publish" cleanly enough for the tab badge.
 */
function listingReadiness(listing: Listing | undefined): number {
  if (!listing) return 0
  let score = 0
  if (typeof listing.title === 'string' && listing.title.trim().length > 0) {
    score += 20
  }
  if (
    typeof listing.description === 'string' &&
    listing.description.trim().length > 0
  ) {
    score += 20
  }
  if (
    Array.isArray(listing.bulletPointsOverride) &&
    listing.bulletPointsOverride.length >= 3
  ) {
    score += 20
  }
  const price =
    typeof listing.price === 'number'
      ? listing.price
      : listing.price != null
        ? Number(listing.price)
        : NaN
  if (Number.isFinite(price) && price > 0) score += 20
  if (typeof listing.quantity === 'number' && listing.quantity >= 0) {
    score += 20
  }
  return score
}

function channelReadiness(channelListings: Listing[]): number | null {
  if (!channelListings || channelListings.length === 0) return null
  const total = channelListings.reduce(
    (acc, l) => acc + listingReadiness(l),
    0,
  )
  return Math.round(total / channelListings.length)
}

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
  // W14.1 — also drives Cmd+K "Jump to <tab>" actions: those router
  // .push(?tab=X), and the effect below picks the change up so the
  // URL is the canonical tab cursor for both initial load and intra-
  // page navigation.
  const [topTab, setTopTab] = useState<TopTab>(() => {
    const initial = searchParams?.get('tab')
    return (initial as TopTab) || 'master'
  })
  // W14.1 — sync state ← URL on every navigation. useState's function
  // initializer runs once, so without this effect a router.push to
  // the same path with a different ?tab would silently no-op. Also
  // handles Cmd+K "Jump to Pricing" → router.replace(?tab=pricing).
  useEffect(() => {
    const next = searchParams?.get('tab')
    if (next && next !== topTab) {
      setTopTab(next as TopTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // W14.1 — wrap setTopTab so every tab click updates the URL too.
  // router.replace (not push) so the back button doesn't have to
  // step through 12 history entries to leave the page. scroll:
  // false because the tab strip is sticky; jumping to top would be
  // visually disorienting. master → drop the param entirely so the
  // canonical URL stays clean.
  const goToTab = useCallback(
    (tab: TopTab) => {
      setTopTab(tab)
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (tab === 'master') params.delete('tab')
      else params.set('tab', tab)
      const qs = params.toString()
      const target = qs ? `?${qs}` : window.location.pathname
      router.replace(target, { scroll: false })
    },
    [router, searchParams],
  )

  // W14.1 — Cmd+K's "Jump to <tab>" actions dispatch the same event
  // name with a `tab` detail. Listening here keeps CommandPalette
  // free of page internals.
  useEffect(() => {
    function onGotoTab(e: Event) {
      const ce = e as CustomEvent<{ tab?: string }>
      const target = ce.detail?.tab
      if (typeof target === 'string' && target.length > 0) {
        goToTab(target as TopTab)
      }
    }
    window.addEventListener('nexus:products-edit:goto-tab', onGotoTab)
    return () =>
      window.removeEventListener('nexus:products-edit:goto-tab', onGotoTab)
  }, [goToTab])

  // W14.2 — Cmd+K's cross-surface "Open <route>" actions. Page listens
  // and routes with its own productId so the palette doesn't need to
  // know which product is open.
  useEffect(() => {
    function onGotoRoute(e: Event) {
      const ce = e as CustomEvent<{ route?: string }>
      const route = ce.detail?.route
      if (route === 'datasheet') {
        router.push(`/products/${product.id}/datasheet`)
      } else if (route === 'matrix' && product.isParent) {
        router.push(`/products/${product.id}/matrix`)
      } else if (route === 'list-wizard') {
        router.push(`/products/${product.id}/list-wizard`)
      } else if (route === 'images') {
        router.push(`/products/${product.id}/images`)
      } else if (route === 'bulk') {
        router.push(`/products/${product.id}/edit/bulk`)
      }
    }
    window.addEventListener('nexus:products-edit:goto-route', onGotoRoute)
    return () =>
      window.removeEventListener(
        'nexus:products-edit:goto-route',
        onGotoRoute,
      )
  }, [router, product.id, product.isParent])
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

  // W14.3 — flat list of tab keys in display order. Powers arrow-key
  // navigation (ArrowLeft/Right cycle through; Home/End jump to ends)
  // and the `aria-controls` / `aria-labelledby` pairing between each
  // tab button and its panel below. Variations only renders when the
  // product is a parent, so it's conditionally included.
  const tabKeys = useMemo<string[]>(() => {
    const base = [
      'master',
      'images',
      'pricing',
      'inventory',
      'locales',
      'compliance',
      'workflow',
      'relations',
      'activity',
    ]
    if (product.isParent) base.push('variations')
    return [...base, ...orderedChannels]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.isParent, orderedChannels.join(',')])

  // W14.4 — mobile tab strip: scroll indicators + auto-scroll active
  // tab into view. Twelve tabs overflow on iPad portrait + every
  // phone; without these affordances the operator would be unaware
  // they can scroll, and arrow-key navigation would silently focus
  // off-screen tabs.
  const tablistRef = useRef<HTMLDivElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const updateScrollIndicators = useCallback(() => {
    const el = tablistRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 4)
    setCanScrollRight(
      el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    )
  }, [])
  useEffect(() => {
    updateScrollIndicators()
    const el = tablistRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollIndicators, { passive: true })
    window.addEventListener('resize', updateScrollIndicators)
    return () => {
      el.removeEventListener('scroll', updateScrollIndicators)
      window.removeEventListener('resize', updateScrollIndicators)
    }
  }, [updateScrollIndicators])
  // Scroll the active tab into view whenever it changes (click,
  // keyboard, URL deep link). Sets behavior:'smooth' on user changes
  // but not on the initial render to avoid a jarring scroll-on-load.
  const initialMount = useRef(true)
  useEffect(() => {
    const el = document.getElementById(`tab-${topTab}`)
    if (!el) return
    el.scrollIntoView({
      behavior: initialMount.current ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
    initialMount.current = false
    // Update fade indicators after the scroll lands.
    requestAnimationFrame(updateScrollIndicators)
  }, [topTab, updateScrollIndicators])

  // W14.3 — keyboard navigation handler for the tablist. Standard
  // WCAG AA pattern: arrows cycle, Home/End jump to ends, focus
  // follows the active tab so screen readers announce the change.
  const onTabListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const idx = tabKeys.indexOf(topTab)
      let nextIdx = -1
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabKeys.length
      else if (e.key === 'ArrowLeft')
        nextIdx = (idx - 1 + tabKeys.length) % tabKeys.length
      else if (e.key === 'Home') nextIdx = 0
      else if (e.key === 'End') nextIdx = tabKeys.length - 1
      else return
      e.preventDefault()
      const nextKey = tabKeys[nextIdx]
      if (!nextKey) return
      // Channel tabs need their first market preselected before the
      // panel renders, mirroring the click handler below.
      if (orderedChannels.includes(nextKey)) {
        if (SINGLE_STORE_CHANNELS.has(nextKey)) {
          setMarketSelection((s) => ({ ...s, [nextKey]: 'GLOBAL' }))
        } else {
          ensureMarketSelected(nextKey)
        }
      }
      goToTab(nextKey)
      // Move DOM focus to the freshly-active tab so screen readers
      // announce it. requestAnimationFrame waits one paint so the
      // tabIndex prop has flipped to 0 before we focus.
      requestAnimationFrame(() => {
        document.getElementById(`tab-${nextKey}`)?.focus()
      })
    },
    [tabKeys, topTab, orderedChannels, goToTab],
  )

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
            {product.isParent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/products/${product.id}/matrix`)}
                title={t('products.edit.matrixTooltip')}
              >
                <LayoutGrid className="w-3.5 h-3.5 mr-1.5" />
                {t('products.edit.matrix')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                router.push(`/products/${product.id}/datasheet`)
              }
              title={t('products.edit.datasheetTooltip')}
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {t('products.edit.datasheet')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/products/${product.id}/edit/bulk`)}
              title={t('products.edit.bulkEditTooltip')}
            >
              <TableProperties className="w-3.5 h-3.5 mr-1.5" />
              {t('products.edit.bulkEdit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/products/${product.id}/recover`)}
              title={t('products.edit.recoverTooltip')}
            >
              <LifeBuoy className="w-3.5 h-3.5 mr-1.5" />
              {t('products.edit.recover')}
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
        <div className="max-w-7xl mx-auto px-6 relative">
          {/* W14.4 — left fade indicator. Only renders when scrolled
              past the start so the affordance disappears at rest. */}
          {canScrollLeft && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-6 top-0 bottom-0 w-8 z-[1] bg-gradient-to-r from-white dark:from-slate-900 to-transparent"
            />
          )}
          {canScrollRight && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-6 top-0 bottom-0 w-8 z-[1] bg-gradient-to-l from-white dark:from-slate-900 to-transparent"
            />
          )}
          <div
            ref={tablistRef}
            role="tablist"
            aria-label={t('products.edit.tablistLabel')}
            className="flex items-center -mb-px overflow-x-auto scroll-smooth"
            onKeyDown={onTabListKeyDown}
          >
            <TopTabButton
              tabKey="master"
              active={topTab === 'master'}
              onClick={() => goToTab('master')}
              dirty={dirtyByTab.master}
            >
              {t('products.edit.tab.master')}
            </TopTabButton>
            <TopTabButton
              tabKey="images"
              active={topTab === 'images'}
              onClick={() => goToTab('images')}
            >
              {t('products.edit.tab.images')}
            </TopTabButton>
            <TopTabButton
              tabKey="pricing"
              active={topTab === 'pricing'}
              onClick={() => goToTab('pricing')}
            >
              {t('products.edit.tab.pricing')}
            </TopTabButton>
            <TopTabButton
              tabKey="inventory"
              active={topTab === 'inventory'}
              onClick={() => goToTab('inventory')}
            >
              {t('products.edit.tab.inventory')}
            </TopTabButton>
            <TopTabButton
              tabKey="locales"
              active={topTab === 'locales'}
              onClick={() => goToTab('locales')}
              dirty={dirtyByTab.locales}
            >
              {t('products.edit.tab.locales')}
            </TopTabButton>
            <TopTabButton
              tabKey="compliance"
              active={topTab === 'compliance'}
              onClick={() => goToTab('compliance')}
            >
              {t('products.edit.tab.compliance')}
            </TopTabButton>
            <TopTabButton
              tabKey="workflow"
              active={topTab === 'workflow'}
              onClick={() => goToTab('workflow')}
            >
              {t('products.edit.tab.workflow')}
            </TopTabButton>
            <TopTabButton
              tabKey="relations"
              active={topTab === 'relations'}
              onClick={() => goToTab('relations')}
            >
              {t('products.edit.tab.relations')}
            </TopTabButton>
            <TopTabButton
              tabKey="activity"
              active={topTab === 'activity'}
              onClick={() => goToTab('activity')}
            >
              {t('products.edit.tab.activity')}
            </TopTabButton>
            {product.isParent && (
              <TopTabButton
                tabKey="variations"
                active={topTab === 'variations'}
                onClick={() => goToTab('variations')}
                count={childrenList.length}
              >
                {t('products.edit.tab.variations')}
              </TopTabButton>
            )}
            {orderedChannels.map((channel) => {
              const isActive = topTab === channel
              const channelListings = listings[channel] ?? []
              const readiness = channelReadiness(channelListings)
              // W14.5 — sum dirty across every per-channel-marketplace
              // tab key so the channel button reflects unsaved across
              // all its markets, not just the active one.
              let channelDirty = 0
              for (const [k, n] of Object.entries(dirtyByTab)) {
                if (k.startsWith(`channel:${channel}:`)) channelDirty += n
              }
              return (
                <TopTabButton
                  key={channel}
                  tabKey={channel}
                  active={isActive}
                  onClick={() => {
                    if (SINGLE_STORE_CHANNELS.has(channel)) {
                      setMarketSelection((s) => ({ ...s, [channel]: 'GLOBAL' }))
                    } else {
                      ensureMarketSelected(channel)
                    }
                    goToTab(channel)
                  }}
                  count={channelListings.length || undefined}
                  readiness={readiness}
                  dirty={channelDirty}
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
          <div role="tabpanel" id="panel-master" aria-labelledby="tab-master">
            <MasterDataTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('master', count)}
            />
          </div>
        )}

        {topTab === 'images' && (
          <div role="tabpanel" id="panel-images" aria-labelledby="tab-images">
            <ImagesTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('images', count)}
            />
          </div>
        )}

        {topTab === 'pricing' && (
          <div role="tabpanel" id="panel-pricing" aria-labelledby="tab-pricing">
            <PricingTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('pricing', count)}
            />
          </div>
        )}

        {topTab === 'inventory' && (
          <div
            role="tabpanel"
            id="panel-inventory"
            aria-labelledby="tab-inventory"
          >
            <InventoryTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('inventory', count)}
            />
          </div>
        )}

        {topTab === 'locales' && (
          <div role="tabpanel" id="panel-locales" aria-labelledby="tab-locales">
            <LocalesTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('locales', count)}
            />
          </div>
        )}

        {topTab === 'compliance' && (
          <div role="tabpanel" id="panel-compliance" aria-labelledby="tab-compliance">
            <ComplianceTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('compliance', count)}
            />
          </div>
        )}

        {topTab === 'workflow' && (
          <div role="tabpanel" id="panel-workflow" aria-labelledby="tab-workflow">
            <WorkflowTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('workflow', count)}
            />
          </div>
        )}

        {topTab === 'relations' && (
          <div
            role="tabpanel"
            id="panel-relations"
            aria-labelledby="tab-relations"
          >
            <RelationsTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('relations', count)}
            />
          </div>
        )}

        {topTab === 'activity' && (
          <div role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
            <ActivityTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('activity', count)}
            />
          </div>
        )}

        {topTab === 'variations' && product.isParent && (
          <div
            role="tabpanel"
            id="panel-variations"
            aria-labelledby="tab-variations"
          >
            <VariationsTab parent={product} childrenList={childrenList} />
          </div>
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
            <div
              role="tabpanel"
              id={`panel-${channel}`}
              aria-labelledby={`tab-${channel}`}
              className={cn(
                'grid gap-6',
                !isSingleStore && 'grid-cols-[200px_1fr]',
              )}
            >
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
  tabKey,
  active,
  onClick,
  children,
  count,
  readiness,
  dirty,
}: {
  /** W14.3 — stable id for ARIA tabpanel pairing + keyboard focus
   *  routing. Must match the panel's `aria-labelledby` and the
   *  arrow-key handler's `getElementById` lookup. */
  tabKey: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
  count?: number
  readiness?: number | null
  /** W14.5 — number of unsaved fields on this tab. Surfaces a small
   *  amber dot so the operator switching tabs can see at a glance
   *  which still has pending edits without checking the header
   *  aggregate. 0 / undefined → no dot. */
  dirty?: number
}) {
  // W5.1 — readiness pill colour-codes the channel: rose for empty,
  // amber while the operator is still filling fields, emerald once
  // every required dimension has a value.
  const readinessTone =
    readiness == null
      ? null
      : readiness >= 100
        ? 'success'
        : readiness >= 60
          ? 'warning'
          : 'danger'
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${tabKey}`}
      aria-selected={active}
      aria-controls={`panel-${tabKey}`}
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
      {readinessTone && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded text-[10px] tabular-nums px-1 py-px font-mono',
            readinessTone === 'success' &&
              'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
            readinessTone === 'warning' &&
              'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
            readinessTone === 'danger' &&
              'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
          )}
          title={`Readiness: ${readiness}%`}
        >
          {readiness}%
        </span>
      )}
      {dirty != null && dirty > 0 && (
        <span
          aria-label={`${dirty} unsaved field${dirty === 1 ? '' : 's'}`}
          title={`${dirty} unsaved field${dirty === 1 ? '' : 's'}`}
          className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
        />
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
