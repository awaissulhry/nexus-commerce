'use client'

/**
 * Product Editor — multi-tab shell.
 *
 * Save / Discard / Publish UX is governed by the DSP-series spec at
 * `docs/edit-ux.md`. Read it before changing any button label,
 * scope, or wiring on this surface. Key invariants enforced there:
 *
 *   - Header "Save" writes the FULL dirty registry (all tabs)
 *     atomically; no per-tab fake saves
 *   - Header "Discard" prompts scope when >1 tab is dirty
 *   - Every "Publish" pre-saves the entire dirty set
 *   - Tab labels show a dirty dot when their tab has unsaved state
 *   - Auto-save is forbidden except on single-toggle controls
 *
 * If a child tab needs to diverge from these rules, update the spec
 * first and link the discussion in the comment.
 */

import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  LifeBuoy,
  SlidersHorizontal,
  Loader2,
  Save,
  X,
} from 'lucide-react'
import { useDirtyRegistry } from './_shared/useDirtyRegistry'
import { useEditorShortcuts } from './_shared/useEditorShortcuts'
import { useNavigationGuard } from './_shared/useNavigationGuard'
import { useHeaderPrefetch } from './useHeaderPrefetch'
import {
  useTabPrefs,
  type TabKey,
  type TabPref,
} from './_shared/useTabPrefs'
import TabPreferencesModal from './_shared/TabPreferencesModal'
import { markClick as markNewTabClick } from '@/lib/perf/markNewTabClick'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import ListOnChannelDropdown from './ListOnChannelDropdown'
import MasterDataTab from './tabs/MasterDataTab'
import dynamic from 'next/dynamic'
import { AnalyticsTab } from './tabs/AnalyticsTab'
import { AdsTab } from './tabs/AdsTab'
import { TimelineTab } from './tabs/TimelineTab'
import WorkflowTab from './tabs/WorkflowTab'
import RelationsTab from './tabs/RelationsTab'
import LocalesTab from './tabs/LocalesTab'
import MatrixTab from './tabs/MatrixTab'
import ChannelListingTab from './tabs/ChannelListingTab'
import EbayCockpit from './tabs/ebay-cockpit/EbayCockpit'
import { useCockpitMode } from './tabs/ebay-cockpit/useCockpitMode'
import AmazonCockpit from './tabs/amazon-cockpit/AmazonCockpit'
import { useAmazonCockpitMode } from './tabs/amazon-cockpit/useAmazonCockpitMode'
import ComplianceTab from './tabs/ComplianceTab'
import ImagesTab from './tabs/ImagesTab'
import SeoTab from './tabs/SeoTab'
import { cn } from '@/lib/utils'
import { useTrackRecentlyViewed } from '@/lib/use-recently-viewed'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { getBackendUrl } from '@/lib/backend-url'
import { VariationFamilyBanner, type FamilyParent, type FamilySibling } from '../../_shared/VariationFamilyBanner'
import { FileSpreadsheet } from 'lucide-react'

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
  parentProduct?: FamilyParent | null
  siblings?: FamilySibling[]
  parentListings?: Record<string, any[]>
}

const SINGLE_STORE_CHANNELS = new Set(['SHOPIFY', 'WOOCOMMERCE', 'ETSY'])
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']

// Lazy-load the Mapping tab — its matrix grid (+ @tanstack/react-virtual)
// stays out of the editor's initial bundle until the tab is opened.
const MappingTab = dynamic(() => import('./tabs/MappingTab'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      Loading mapping…
    </div>
  ),
})

// EH.1 — anchor styling that mirrors Button variant=ghost size=sm. Kept as
// a string constant so all three "open in new tab" header anchors stay in
// sync without forking the Button component for asChild support.
// EH.9 — whitespace-nowrap so the label + ↗ glyph never wrap onto two
// lines on narrow viewports (which would jump the anchor's hit target
// in a way that triggers double-clicks).
const headerOpenInNewTabClass =
  'group inline-flex items-center justify-center font-medium border rounded-md transition-colors ' +
  'h-7 px-2.5 text-base gap-1 whitespace-nowrap ' +
  'bg-transparent hover:bg-slate-100 text-slate-700 border-transparent ' +
  'dark:hover:bg-slate-800 dark:text-slate-300 ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900'

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
  parentProduct = null,
  siblings = [],
  parentListings = {},
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslations()
  const confirm = useConfirm()

  // EC.1 — eBay channel UI mode toggle ('cockpit' vs 'classic').
  // Default is 'cockpit' for the eBay channel during the EC engagement.
  // Operators can flip back to 'classic' from the cockpit header; the
  // choice persists in localStorage. Other channels ignore this flag.
  const [cockpitMode] = useCockpitMode()
  // AC.1 — Amazon channel UI mode toggle ('cockpit' vs 'classic').
  // Separate storage key from eBay so the choice doesn't bleed across
  // channels. Default 'cockpit' during the AC engagement; once AC.12
  // (publish flow) stabilises we drop the toggle.
  const [amazonCockpitMode] = useAmazonCockpitMode()

  // EH.7 — Pre-warm the API caches that the Datasheet / Flat File /
  // Recover new-tab anchors will hit. Mount-warm kicks off on first
  // render at low priority; the returned hover handlers fire at
  // normal priority on mouseenter/focus.
  const headerPrefetch = useHeaderPrefetch({
    productId: product.id,
    productType: (product.productType as string | null) ?? null,
    familyId: ((product as any).parentId as string | undefined) ?? product.id,
    marketplace: 'IT',
  })
  // U.30 — read initial tab from `?tab=<x>`. HierarchyLens deep-links
  // to /products/${id}/edit?tab=variations; pre-fix the link silently
  // landed on master.
  // W14.1 — also drives Cmd+K "Jump to <tab>" actions: those router
  // .push(?tab=X), and the effect below picks the change up so the
  // URL is the canonical tab cursor for both initial load and intra-
  // page navigation.
  const [topTab, setTopTab] = useState<TopTab>(() => {
    const initial = searchParams?.get('tab')
    // TC.2 — `?tab=global` is the old (pre-TC) URL for the now-merged
    // Master tab. Quietly map it to 'master' so bookmarks + deep
    // links from elsewhere don't 404 the operator into a dead tab.
    if (initial === 'global') return 'master'
    return (initial as TopTab) || 'master'
  })

  // TC.6 — visibility + order driven by useTabPrefs (replaces the
  // legacy binary `showAllTabs` toggle persisted as
  // `product-edit:show-all-tabs`). TC.8 migrates that legacy key.
  // TC.7 — Reset-to-defaults is owned by TabPreferencesModal via its
  // own draft state; the hook's resetToDefaults export stays available
  // for any future programmatic caller (e.g. an admin "reset all
  // preferences" tool) but isn't needed here.
  const { orderedPrefs, setOrderedPrefs } = useTabPrefs()
  // TC.6 — Customize Tabs modal open/close state.
  const [tabsModalOpen, setTabsModalOpen] = useState(false)
  // W14.1 — sync state ← URL on every navigation. useState's function
  // initializer runs once, so without this effect a router.push to
  // the same path with a different ?tab would silently no-op. Also
  // handles Cmd+K "Jump to Pricing" → router.replace(?tab=pricing).
  useEffect(() => {
    const next = searchParams?.get('tab')
    // TC.2 — same legacy shim as the initial-state seed: `?tab=global`
    // resolves to `master`. We also canonicalise the URL via goToTab
    // so the address bar matches what the operator actually sees
    // (no stale ?tab=global hanging around in history).
    if (next === 'global') {
      if (topTab !== 'master') setTopTab('master')
      goToTab('master')
      return
    }
    if (next && next !== topTab) {
      setTopTab(next as TopTab)
    }
    // A.3 — reconcile the market too, so back/forward + deep-links restore
    // the full coordinate. Read fresh; validate against the channel's markets.
    const mkt = searchParams?.get('market')
    if (next && mkt && marketplaces[next]?.some((m) => m.code === mkt)) {
      setMarketSelection((s) => (s[next] === mkt ? s : { ...s, [next]: mkt }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // A.2/A.3 — the URL is the single canonical cursor for the coordinate
  // (tab + market). goToCoordinate writes BOTH; market is attached only for
  // multi-market channel tabs (dropped for master + single-store). push when
  // the coordinate actually changes so back/forward walks tabs+markets;
  // replace on a no-op/canonicalisation so we don't pile up junk history or
  // loop. scroll:false because the tab strip is sticky.
  const goToCoordinate = useCallback(
    (tab: TopTab, market?: string) => {
      setTopTab(tab)
      const attachMarket =
        !!market && tab !== 'master' && !SINGLE_STORE_CHANNELS.has(tab as string)
      if (attachMarket) {
        setMarketSelection((s) => ({ ...s, [tab as string]: market! }))
      }
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (tab === 'master') params.delete('tab')
      else params.set('tab', tab)
      if (attachMarket) params.set('market', market!)
      else params.delete('market')
      const qs = params.toString()
      // Absolute `${pathname}?${qs}` via the Next router — the proven cursor
      // pattern used by OrdersWorkspace. Going through the router keeps Next's
      // history in sync so sidebar/<Link> navigation keeps working (a manual
      // window.history.pushState here corrupted the router state and broke
      // in-app nav). push on a real coordinate change so back/forward walks
      // tabs+markets; replace on a no-op/canonicalisation.
      const target = qs ? `${pathname}?${qs}` : pathname
      // Always router.replace — the PROVEN OrdersWorkspace cursor form. It
      // reliably updates the URL bar AND keeps Next's history in sync (so
      // sidebar/<Link> navigation keeps working — a manual history.pushState
      // corrupted that). Tabs needn't pile browser history, so replace (not
      // push) is the right call.
      router.replace(target, { scroll: false })
    },
    [router, pathname, searchParams],
  )
  // Non-channel tabs carry no market — thin wrapper so the cursor logic
  // lives in one place (also clears a stale ?market when leaving a channel).
  const goToTab = useCallback((tab: TopTab) => goToCoordinate(tab), [goToCoordinate])

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
        // ATM.1 — Hub is the default. /datasheet/print is the print-only.
        router.push(`/products/${product.id}/datasheet`)
      } else if (route === 'datasheet-print') {
        router.push(`/products/${product.id}/datasheet/print`)
      } else if (route === 'matrix' && product.isParent) {
        router.push(`/products/${product.id}/matrix`)
      } else if (route === 'list-wizard') {
        router.push(`/products/${product.id}/list-wizard`)
      } else if (route === 'images') {
        router.push(`/products/${product.id}/images`)
      }
      // CL.1 — 'bulk' route handler removed alongside the
      // /edit/bulk page + Command Palette entry.
    }
    window.addEventListener('nexus:products-edit:goto-route', onGotoRoute)
    return () =>
      window.removeEventListener(
        'nexus:products-edit:goto-route',
        onGotoRoute,
      )
  }, [router, product.id, product.isParent])
  // Per-channel selected marketplace (key by channel)
  // A.1 — seed the active channel's market from ?market= so deep-links +
  // refresh land on the right coordinate. Validate against the channel's
  // real markets (a shared link may carry a market this product/channel
  // doesn't have) — fall through to preferredMarketCode otherwise.
  const [marketSelection, setMarketSelection] = useState<Record<string, string>>(() => {
    const tab = searchParams?.get('tab')
    const market = searchParams?.get('market')
    if (tab && market && marketplaces[tab]?.some((m) => m.code === market)) {
      return { [tab]: market }
    }
    return {}
  })

  // Client-side listings cache — seeded from SSR prop, refreshed whenever
  // the flat file (or any other source) writes to ChannelListing. This
  // ensures the Amazon/eBay/Shopify tabs always show current data without
  // needing a full page reload.
  const [clientListings, setClientListings] = useState<Record<string, Listing[]>>(listings)
  useInvalidationChannel('channel-pricing.updated', () => {
    void fetch(`${getBackendUrl()}/api/products/${product.id}/all-listings`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setClientListings(data) })
  })

  // P-RT.1 — keep one SSE pipe open on the edit page so tabs subscribed
  // to product.* / listing.* / pim.changed invalidation events
  // (Timeline, MasterData, ChannelListing, etc.) refresh sub-200ms
  // when a webhook, bulk worker, or another tab mutates this product.
  // The edit page doesn't render the Live chip — that's the grid's job.
  // P-RT.6 — destructure lastEvent so the toast effect below can react
  // to listing.synced outcomes for this product's listings.
  const { lastEvent: lastSseEvent } = useListingEvents()
  useInvalidationChannel(['product.updated', 'listing.updated'], (event) => {
    if (event.type === 'product.updated' && event.id !== product.id) return
    void fetch(`${getBackendUrl()}/api/products/${product.id}/all-listings`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setClientListings(data) })
  })

  // P-RT.6 — surface channel push outcomes on the edit page. Today
  // the operator saves a price/title, the worker queues an outbound
  // sync, and ~30-60s later either it lands on Amazon or Amazon
  // rejects it ("price below minimum", "listing suppressed", etc).
  // Without this effect that outcome is silently filed away in the
  // Timeline tab — the operator never sees it unless they click into
  // Timeline. Now: listing.synced for any listing in this product
  // pops a toast. SUCCEEDED reassures the operator their save reached
  // the channel; FAILED + TIMEOUT surface the failure immediately so
  // they can react (revert, fix, retry) rather than discover hours
  // later via a customer complaint. We rely on the local clientListings
  // map (kept fresh by the invalidation effect above) to filter SSE
  // noise to events that belong to THIS product.
  const { toast } = useToast()
  const knownListingIds = useMemo(() => {
    const set = new Set<string>()
    for (const arr of Object.values(clientListings)) {
      for (const l of arr) set.add(l.id)
    }
    return set
  }, [clientListings])
  // Track the IDs we've already toasted on so a re-render or
  // duplicate event from the bus doesn't double-toast.
  const toastedEventsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!lastSseEvent) return
    if (lastSseEvent.type !== 'listing.synced') return
    const lid = lastSseEvent.listingId
    if (!lid || !knownListingIds.has(lid)) return
    // Dedup by listingId + ts so we don't re-toast on React StrictMode
    // double-invoke or on a re-render that re-runs the effect.
    const dedupKey = `${lid}:${lastSseEvent.ts ?? 0}`
    if (toastedEventsRef.current.has(dedupKey)) return
    toastedEventsRef.current.add(dedupKey)
    // Trim the dedup set so it doesn't grow unbounded over a long
    // session — 100 entries is plenty (the bus typically fires <10
    // events/min for any one product).
    if (toastedEventsRef.current.size > 100) {
      const first = toastedEventsRef.current.values().next().value
      if (first) toastedEventsRef.current.delete(first)
    }
    // Look up the channel from the local listings map so the toast
    // copy reads "Amazon" not "cl_abc123".
    let channelLabel = 'channel'
    for (const [chKey, arr] of Object.entries(clientListings)) {
      if (arr.some((l) => l.id === lid)) {
        channelLabel = LABEL_CASE[chKey] ?? chKey
        break
      }
    }
    const status = lastSseEvent.status
    if (status === 'SUCCESS') {
      toast.success(t('products.edit.sync.success', { channel: channelLabel }))
    } else if (status === 'FAILED') {
      toast.error(
        t('products.edit.sync.failed', { channel: channelLabel }),
      )
    } else if (status === 'TIMEOUT') {
      toast.error(t('products.edit.sync.timeout', { channel: channelLabel }))
    }
    // NOT_IMPLEMENTED is silent — channel adapter doesn't support
    // this op yet, no need to bother the operator.
  }, [lastSseEvent, knownListingIds, clientListings, toast, t])

  // W1.1 / DSP.1 — central dirty-state registry. Each tab calls
  // onDirtyChange(count) which routes into registry.register(); the
  // header reads `registry.byTab` for per-tab dots and `registry.total`
  // for the aggregate badge. DSP.2+ will add `flush()` callbacks per
  // tab so header Save can await every pending write in parallel
  // (currently we still rely on the 800ms debounce drain in
  // handleHeaderSave for tabs that haven't been migrated). See
  // `docs/edit-ux.md` for the full model.
  const registry = useDirtyRegistry()
  const totalDirty = registry.total
  const isDirty = registry.isDirty
  // Back-compat shim: existing tabs pass count-only via onDirtyChange.
  // DSP.2+ will switch them to register({ count, flush, discard })
  // directly. Until then, keep this so no tab needs to change yet.
  // DSP.3 — also stamp a human-readable label so the Discard scope
  // modal renders meaningful names ("Images", "SEO", etc.) instead
  // of raw tab keys. Labels are looked up from the same i18n keys
  // the tab strip uses.
  const tabLabel = useCallback(
    (tabKey: string): string => {
      // Channel listing keys (e.g. "AMAZON__IT", "EBAY__US") are
      // dynamic — show them as "Channel: AMAZON IT" rather than the
      // raw __ format.
      if (tabKey.includes('__')) {
        const [channel, marketplace] = tabKey.split('__')
        return t('products.edit.discardScopeChannel', {
          channel: channel ?? '',
          marketplace: marketplace ?? '',
        })
      }
      // Well-known static tabs map to the same labels the tab strip
      // renders. Fallback to the raw key for anything unknown.
      const knownKey = `products.edit.tab.${tabKey}`
      const localized = t(knownKey)
      return localized === knownKey ? tabKey : localized
    },
    [t],
  )
  const setTabDirty = useCallback(
    (tabKey: string, count: number) =>
      registry.register(tabKey, { count, label: tabLabel(tabKey) }),
    [registry, tabLabel],
  )
  // Derived shape that matches the old `dirtyByTab: Record<string, number>`
  // so existing UI lookups (e.g. tab dirty dots) keep working without
  // every call site needing to change.
  const dirtyByTab = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [k, e] of Object.entries(registry.byTab)) out[k] = e.count
    return out
  }, [registry.byTab])
  // Bumped by Discard. Tabs watch this prop; on change they cancel
  // pending debounce timers, drop their dirty set, and reseed values
  // from the freshly-fetched product. Channel tabs additionally hard-
  // remount via key so any in-progress side-effects unwind cleanly.
  const [discardSignal, setDiscardSignal] = useState(0)
  const [showCreatedBanner, setShowCreatedBanner] = useState(
    () => searchParams?.get('created') === '1',
  )
  const [headerSaving, setHeaderSaving] = useState(false)
  const [headerSaved, setHeaderSaved] = useState(false)

  const handleHeaderSave = useCallback(async () => {
    if (headerSaving) return
    setHeaderSaving(true)
    try {
      // DSP.1 — real Save All: await every tab's registered flush()
      // in parallel. Tabs that haven't migrated to register a flush
      // (still on debounce auto-save) get the 800ms drain below as
      // a back-compat fallback. After DSP.2+ migrates them, the
      // 800ms wait collapses to ~0.
      await registry.saveAll()
      await new Promise((r) => window.setTimeout(r, 800))
      setHeaderSaved(true)
      router.refresh()
      window.setTimeout(() => setHeaderSaved(false), 1500)
    } catch (err) {
      // Surface failure so the operator knows the save didn't land.
      // Don't refresh — keep the dirty state so they can retry.
      toast({
        title: t('products.edit.saveFailed'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      })
    } finally {
      setHeaderSaving(false)
    }
  }, [headerSaving, registry, router, toast, t])

  // NN.3 / DSP.8 — unified navigation guard. Covers both browser-level
  // tab close / refresh (beforeunload) AND in-app <a> click navigation
  // (sidebar, breadcrumb, dashboard links). Pre-DSP.8 the latter
  // silently navigated even with unsaved state because Next.js App
  // Router doesn't fire beforeunload on client-side route changes.
  useNavigationGuard({
    enabled: isDirty,
    message: t('products.edit.navGuardMessage'),
  })

  // DSP.9 — keyboard shortcuts: Cmd+S (Save All) and Esc (Discard).
  // Cmd+Shift+S (Save & Publish) is intentionally not wired here —
  // ProductEditClient doesn't own a default Publish target (that
  // lives in ImagesTab's per-product remembered channel from DSP.6).
  // Future: thread an onSaveAndPublish from ImagesTab up to register
  // with the header so the shortcut works on any tab.
  useEditorShortcuts({
    enabled: true,
    onSave: () => void handleHeaderSave(),
    onDiscard: () => void handleDiscard(),
  })

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
    // DSP.3 — scope-aware confirm. List every dirty tab in the modal
    // body so the operator sees exactly what they're about to lose
    // BEFORE confirming. Pre-DSP.3 the modal just said "Discard 3
    // unsaved fields?" with no indication of which tabs were affected.
    const dirtyTabs = Object.entries(registry.byTab)
      .filter(([, entry]) => entry.count > 0)
      .map(([key, entry]) => ({
        key,
        label: entry.label ?? key,
        count: entry.count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))

    const fieldsLabel = (count: number) =>
      count === 1
        ? t('products.edit.discardScopeFields', { count })
        : t('products.edit.discardScopeFieldsPlural', { count })

    const ok = await confirm({
      title:
        totalDirty === 1
          ? t('products.edit.discardConfirmOne')
          : t('products.edit.discardConfirmMany', { count: totalDirty }),
      description: (
        <div className="space-y-2">
          <p className="text-sm">{t('products.edit.discardScopeBody')}</p>
          <ul className="space-y-1 text-sm">
            {dirtyTabs.map((tab) => (
              <li key={tab.key} className="flex items-baseline gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 mt-1 flex-shrink-0" />
                <span className="font-medium">{tab.label}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  ({fieldsLabel(tab.count)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ),
      confirmLabel: t('products.edit.discardCta'),
      tone: 'warning',
    })
    if (!ok) return
    // DSP.1 — call every registered discard handler first, then bump
    // the legacy discardSignal for tabs that haven't migrated.
    // Setting an empty count via the shim isn't enough — the registry
    // keeps callbacks; we just reset counts to 0 so the dots clear.
    registry.discardAll()
    for (const k of Object.keys(registry.byTab)) {
      registry.register(k, { count: 0 })
    }
    setDiscardSignal((s) => s + 1)
    router.refresh()
  }

  // WOOCOMMERCE and ETSY are not active channels for this operator —
  // only show them if there are actual listings (i.e. they were
  // connected at some point and have data). Amazon / eBay / Shopify
  // appear whenever the marketplaces endpoint returns them.
  const orderedChannels = CHANNEL_ORDER.filter((c) => {
    if (c === 'WOOCOMMERCE' || c === 'ETSY') return (clientListings[c]?.length ?? 0) > 0
    return (marketplaces[c]?.length ?? 0) > 0
  })

  // TC.6 — visible tabs in display order, derived from useTabPrefs
  // and filtered by what's actually available for this product:
  //   - Channel tabs (AMAZON/EBAY/SHOPIFY/WOOCOMMERCE/ETSY) only
  //     render when the channel exists for this product.
  //   - The currently active tab is always included even if hidden
  //     in prefs (session-only safety) so URL-deep-linked operators
  //     don't lose their place.
  const orderedChannelsSet = useMemo(
    () => new Set<string>(orderedChannels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedChannels.join(',')],
  )
  const isChannelKey = (k: string) =>
    k === 'AMAZON' || k === 'EBAY' || k === 'SHOPIFY' || k === 'WOOCOMMERCE' || k === 'ETSY'
  const visiblePrefs = useMemo<TabPref[]>(() => {
    const filtered = orderedPrefs.filter((p) => {
      if (isChannelKey(p.key) && !orderedChannelsSet.has(p.key)) return false
      return p.visible
    })
    // Active-tab safety: if topTab isn't in the filtered set, splice
    // it in at its prefs-position so the operator can still see where
    // they are. Channel tabs that don't exist on this product stay
    // excluded (they'd render no body anyway).
    if (topTab && !filtered.some((p) => p.key === topTab)) {
      const isCurrentChannelMissing = isChannelKey(topTab) && !orderedChannelsSet.has(topTab)
      if (!isCurrentChannelMissing) {
        const idx = orderedPrefs.findIndex((p) => p.key === topTab)
        const synthetic: TabPref = { key: topTab as TabKey, visible: true }
        if (idx < 0) {
          filtered.push(synthetic)
        } else {
          // Insert at a position roughly matching its prefs index.
          let insertAt = 0
          for (let i = 0; i < idx; i++) {
            if (filtered.some((p) => p.key === orderedPrefs[i].key)) insertAt++
          }
          filtered.splice(insertAt, 0, synthetic)
        }
      }
    }
    return filtered
  }, [orderedPrefs, orderedChannelsSet, topTab])

  // W14.3 — flat list of tab keys in display order. Powers arrow-key
  // navigation (ArrowLeft/Right cycle through; Home/End jump to ends)
  // and the `aria-controls` / `aria-labelledby` pairing between each
  // tab button and its panel below. Tracks `visiblePrefs` so cycling
  // never lands on a hidden tab.
  const tabKeys = useMemo<string[]>(
    () => visiblePrefs.map((p) => p.key),
    [visiblePrefs],
  )

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
        // A.2 — channel tabs carry their market in the URL too.
        if (SINGLE_STORE_CHANNELS.has(nextKey)) {
          goToCoordinate(nextKey)
        } else {
          goToCoordinate(nextKey, ensureMarketSelected(nextKey))
        }
      } else {
        goToTab(nextKey)
      }
      // Move DOM focus to the freshly-active tab so screen readers
      // announce it. requestAnimationFrame waits one paint so the
      // tabIndex prop has flipped to 0 before we focus.
      requestAnimationFrame(() => {
        document.getElementById(`tab-${nextKey}`)?.focus()
      })
    },
    [tabKeys, topTab, orderedChannels, goToTab, goToCoordinate],
  )

  const hasListing = (channel: string, marketplace: string) =>
    clientListings[channel]?.some((l) => l.marketplace === marketplace) ?? false

  const getListing = (channel: string, marketplace: string) =>
    clientListings[channel]?.find((l) => l.marketplace === marketplace)

  // Preferred default market for a channel when nothing is selected
  // yet. Priority:
  //   1. Xavia's primary market 'IT' when present (per
  //      project_xavia_context memory — Amazon IT is the home market;
  //      caught during AC-series verification when GALE-JACKET landed
  //      on BE alphabetical).
  //   2. First market that already has a ChannelListing (operator has
  //      done work there).
  //   3. First market alphabetically (channelMarkets[0]).
  //   4. 'GLOBAL' literal for single-store channels.
  const preferredMarketCode = (channel: string): string => {
    const channelMarkets = marketplaces[channel] ?? []
    const it = channelMarkets.find((m) => m.code === 'IT')
    if (it) return it.code
    const firstWithListing = channelMarkets.find((m) =>
      hasListing(channel, m.code),
    )
    if (firstWithListing) return firstWithListing.code
    return channelMarkets[0]?.code ?? 'GLOBAL'
  }

  const ensureMarketSelected = (channel: string): string => {
    const existing = marketSelection[channel]
    if (existing) return existing
    const fallback = preferredMarketCode(channel)
    setMarketSelection((s) => ({ ...s, [channel]: fallback }))
    return fallback
  }

  // TC.6 — single render helper that maps a canonical tab key to its
  // <TopTabButton>. Centralising the per-tab props (label, count,
  // readiness, dirty source, click handler) keeps the strip layer
  // declarative — the new render path is just visiblePrefs.map.
  const renderTopTab = (key: TabKey) => {
    const isActive = topTab === key
    const dirty = dirtyByTab[key]
    switch (key) {
      case 'master':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('master')}
            dirty={dirty}
          >
            {t('products.edit.tab.master')}
          </TopTabButton>
        )
      case 'images':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('images')}
            dirty={dirty}
          >
            {t('products.edit.tab.images')}
          </TopTabButton>
        )
      case 'locales':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('locales')}
            dirty={dirty}
          >
            {t('products.edit.tab.locales')}
          </TopTabButton>
        )
      case 'seo':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('seo')}
            dirty={dirty}
          >
            {t('products.edit.tab.seo')}
          </TopTabButton>
        )
      case 'compliance':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('compliance')}
            dirty={dirty}
          >
            {t('products.edit.tab.compliance')}
          </TopTabButton>
        )
      case 'workflow':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('workflow')}
            dirty={dirty}
          >
            {t('products.edit.tab.workflow')}
          </TopTabButton>
        )
      case 'relations':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('relations')}
            dirty={dirty}
          >
            {t('products.edit.tab.relations')}
          </TopTabButton>
        )
      case 'activity':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('activity')}
            dirty={dirty}
          >
            Timeline
          </TopTabButton>
        )
      case 'matrix':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('matrix')}
            count={product.isParent ? childrenList.length : undefined}
          >
            Matrix
          </TopTabButton>
        )
      case 'analytics':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('analytics')}
          >
            Analytics
          </TopTabButton>
        )
      case 'ads':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('ads')}
          >
            Ads
          </TopTabButton>
        )
      case 'mapping':
        return (
          <TopTabButton
            key={key}
            tabKey={key}
            active={isActive}
            onClick={() => goToTab('mapping')}
          >
            Mapping
          </TopTabButton>
        )
      case 'AMAZON':
      case 'EBAY':
      case 'SHOPIFY':
      case 'WOOCOMMERCE':
      case 'ETSY': {
        const channel = key
        const channelListings = clientListings[channel] ?? []
        const readiness = channelReadiness(channelListings)
        // W14.5 — sum dirty across every per-channel-marketplace tab
        // key so the channel button reflects unsaved across all its
        // markets, not just the active one.
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
              // A.2 — write tab + market to the URL in one move.
              if (SINGLE_STORE_CHANNELS.has(channel)) {
                goToCoordinate(channel)
              } else {
                goToCoordinate(channel, ensureMarketSelected(channel))
              }
            }}
            count={channelListings.length || undefined}
            readiness={readiness}
            dirty={channelDirty}
          >
            {LABEL_CASE[channel] ?? channel}
          </TopTabButton>
        )
      }
      default:
        return null
    }
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
            {/* EH.1 — Matrix header button removed. The in-page Matrix tab
                (above) is the canonical surface; the standalone /matrix route
                is still reachable via Cmd+K. */}
            {/* EH.1 — Datasheet / Flat File / Recover now open in a new tab
                via real <a target="_blank"> anchors so Cmd+Click, middle-click,
                and right-click "Open in new tab" all work natively, and the
                /edit context never gets blown away by a router.push. */}
            <a
              href={`/products/${product.id}/datasheet`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('products.edit.datasheetTooltip')}
              onMouseEnter={headerPrefetch.onHoverDatasheet}
              onFocus={headerPrefetch.onHoverDatasheet}
              onClick={() => markNewTabClick('datasheet', product.id)}
              onAuxClick={() => markNewTabClick('datasheet', product.id)}
              className={headerOpenInNewTabClass}
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" aria-hidden />
              {t('products.edit.datasheet')}
              <ExternalLink className="w-3 h-3 ml-1 opacity-60 group-hover:opacity-100 transition-opacity" aria-hidden />
              <span className="sr-only">{t('products.edit.opensInNewTab')}</span>
            </a>
            {/* CL.1 — Bulk Edit button + /edit/bulk route removed.
                MatrixTab covers price/qty bulk edits inline; the
                channel sub-tabs handle marketplace attribute editing.
                The standalone bulk page (2,121 lines) was unused. */}
            {(() => {
              const pt = (product.productType as string | null) ?? 'OUTERWEAR'
              const familyId = (product as any).parentId ?? product.id
              const href = `/products/amazon-flat-file?familyId=${familyId}&productType=${pt}&marketplace=IT`
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('products.edit.flatFileTooltip')}
                  onMouseEnter={headerPrefetch.onHoverFlatFile}
                  onFocus={headerPrefetch.onHoverFlatFile}
                  onClick={() => markNewTabClick('flatFile', familyId)}
                  onAuxClick={() => markNewTabClick('flatFile', familyId)}
                  className={headerOpenInNewTabClass}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" aria-hidden />
                  {t('products.edit.flatFile')}
                  <ExternalLink className="w-3 h-3 ml-1 opacity-60 group-hover:opacity-100 transition-opacity" aria-hidden />
                  <span className="sr-only">{t('products.edit.opensInNewTab')}</span>
                </a>
              )
            })()}
            <a
              href={`/products/${product.id}/recover`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('products.edit.recoverTooltip')}
              onMouseEnter={headerPrefetch.onHoverRecover}
              onFocus={headerPrefetch.onHoverRecover}
              onClick={() => markNewTabClick('recover', product.id)}
              onAuxClick={() => markNewTabClick('recover', product.id)}
              className={headerOpenInNewTabClass}
            >
              <LifeBuoy className="w-3.5 h-3.5 mr-1.5" aria-hidden />
              {t('products.edit.recover')}
              <ExternalLink className="w-3 h-3 ml-1 opacity-60 group-hover:opacity-100 transition-opacity" aria-hidden />
              <span className="sr-only">{t('products.edit.opensInNewTab')}</span>
            </a>
            <ListOnChannelDropdown productId={product.id} />
            <Button
              size="sm"
              onClick={handleHeaderSave}
              loading={headerSaving}
              disabled={!isDirty && !headerSaved}
              title={isDirty ? 'Save all pending changes' : 'No unsaved changes'}
              icon={
                headerSaved
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  : headerSaving
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Save className="w-3.5 h-3.5" />
              }
            >
              {headerSaved ? 'Saved' : 'Save'}
            </Button>
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

        {/* ── Variation family banner (child products only) ── */}
        {parentProduct && (
          <VariationFamilyBanner
            currentProductId={product.id}
            currentParentAsin={product.parentAsin ?? null}
            parentProduct={parentProduct}
            siblings={siblings}
            parentListings={parentListings}
          />
        )}

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
            {/* TC.6 — Strip is now driven by useTabPrefs (visibility +
                order). The renderTopTab helper maps each canonical key
                to its TopTabButton with the right label / count /
                readiness / dirty wiring. Channel tabs that aren't on
                this product are filtered out at visiblePrefs time.
                The active-but-hidden case is also handled there so the
                operator never lands on a missing tab.
                TC.9 — `p.visible=false` here means the tab is only
                present because it's the currently active topTab
                (session-only safety). We clone the rendered element
                with `pinned={false}` so TopTabButton renders the
                dashed-border cue. cloneElement avoids editing the
                13 switch cases just to thread one extra prop. */}
            {visiblePrefs.map((p) => {
              const element = renderTopTab(p.key)
              if (!p.visible && isValidElement(element)) {
                return cloneElement(element, { pinned: false } as { pinned: boolean })
              }
              return element
            })}
            {/* TC.6 — Customize Tabs button at end of strip. Opens
                TabPreferencesModal; replaces the legacy binary
                "+ More tabs / Show less" toggle with a proper
                visibility + reorder UI. */}
            <button
              type="button"
              onClick={() => setTabsModalOpen(true)}
              title={t('products.edit.tabs.customize.openButtonTooltip')}
              aria-label={t('products.edit.tabs.customize.openButton')}
              className="flex-shrink-0 ml-1 px-2 py-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 border-b-2 border-transparent whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
            >
              <SlidersHorizontal className="w-4 h-4" aria-hidden />
            </button>
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
        {/* TC.2 — Global tab body dispatch dropped; merged into Master. */}

        {topTab === 'master' && (
          <div role="tabpanel" id="panel-master" aria-labelledby="tab-master">
            <MasterDataTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('master', count)}
              onRegister={(handlers) =>
                registry.register('master', {
                  label: t('products.edit.tab.master'),
                  ...handlers,
                })
              }
            />
          </div>
        )}

        {topTab === 'images' && (
          <div role="tabpanel" id="panel-images" aria-labelledby="tab-images">
            <ImagesTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('images', count)}
              onPreSaveAll={registry.saveAll}
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

        {topTab === 'seo' && (
          <div role="tabpanel" id="panel-seo" aria-labelledby="tab-seo">
            <SeoTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('seo', count)}
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
            <TimelineTab
              product={product}
              discardSignal={discardSignal}
              onDirtyChange={(count) => setTabDirty('activity', count)}
            />
          </div>
        )}

        {topTab === 'matrix' && (
          <div
            role="tabpanel"
            id="panel-matrix"
            aria-labelledby="tab-matrix"
          >
            <MatrixTab
              product={product}
              onDirtyChange={() => {}}
              discardSignal={discardSignal}
            />
          </div>
        )}

        {topTab === 'analytics' && (
          <div role="tabpanel" id="panel-analytics" aria-labelledby="tab-analytics">
            <AnalyticsTab productId={product.id} />
          </div>
        )}

        {topTab === 'mapping' && (
          <div role="tabpanel" id="panel-mapping" aria-labelledby="tab-mapping">
            <MappingTab product={product} />
          </div>
        )}

        {topTab === 'ads' && (
          <div role="tabpanel" id="panel-ads" aria-labelledby="tab-ads">
            <AdsTab
              productId={product.id}
              asin={product.amazonAsin ?? null}
              sku={product.sku}
            />
          </div>
        )}

        {orderedChannels.includes(topTab) && (() => {
          const channel = topTab
          const isSingleStore = SINGLE_STORE_CHANNELS.has(channel)
          const channelMarkets = marketplaces[channel] ?? []
          const selectedMarket =
            marketSelection[channel] ?? preferredMarketCode(channel)
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
          // AC.3 / FX — When a cockpit (Amazon OR eBay) is active its own
          // chip strip replaces the MarketplaceSidebar. Hide the left rail
          // so the cockpit gets full width, and drop the 200px grid column
          // so the layout collapses to single-column. (Was Amazon-only,
          // which left the eBay cockpit with a duplicate market sidebar.)
          const amazonCockpitMounted =
            channel === 'AMAZON' && amazonCockpitMode === 'cockpit'
          const ebayCockpitMounted = channel === 'EBAY' && cockpitMode === 'cockpit'
          const cockpitMounted = amazonCockpitMounted || ebayCockpitMounted
          return (
            <div
              role="tabpanel"
              id={`panel-${channel}`}
              aria-labelledby={`tab-${channel}`}
              className={cn(
                'grid gap-6',
                !isSingleStore && !cockpitMounted && 'grid-cols-[200px_minmax(0,1fr)]',
              )}
            >
              {!isSingleStore && !cockpitMounted && (
                <MarketplaceSidebar
                  channel={channel}
                  marketplaces={channelMarkets}
                  selected={selectedMarket}
                  hasListing={hasListing}
                  onSelect={(code) => goToCoordinate(channel, code)}
                />
              )}
              {/* EC.1 — Route eBay through the Listing Cockpit when the
                  operator hasn't opted out. Every other channel keeps
                  the classic ChannelListingTab unchanged. The cockpit
                  itself currently embeds ChannelListingTab as a
                  transitional pass-through, so no eBay functionality
                  is lost while EC.4–EC.8 cards land. */}
              {channel === 'EBAY' && cockpitMode === 'cockpit' ? (
                <EbayCockpit
                  key={`${channel}_${selectedMarket}_${discardSignal}_cockpit`}
                  product={product}
                  marketplace={selectedMarket}
                  marketInfo={marketInfo}
                  siblingMarkets={channelMarkets.filter((m) => m.code !== selectedMarket)}
                  /* EC.2 — sibling listings on the SAME channel for
                     OTHER marketplaces; feeds the Sibling source
                     resolver in ListingEssentialsCard. */
                  siblingListings={(clientListings[channel] ?? []).filter(
                    (l: Listing) => l.marketplace !== selectedMarket,
                  )}
                  listing={listing}
                  onDirtyChange={(count) => setTabDirty(tabKey, count)}
                  onSave={() => router.refresh()}
                  onRegister={(handlers) =>
                    registry.register(tabKey, {
                      label: t('products.edit.discardScopeChannel', {
                        channel,
                        marketplace: selectedMarket,
                      }),
                      ...handlers,
                    })
                  }
                  childrenList={childrenList}
                  onMarketSwitch={(code) => goToCoordinate(channel, code)}
                  getDirtyForMarket={(code) =>
                    dirtyByTab[`channel:${channel}:${code}`] ?? 0
                  }
                  flushActiveMarket={async () => {
                    const e = registry.byTab[tabKey]
                    if (e?.flush) await e.flush()
                  }}
                  discardActiveMarket={() => {
                    const e = registry.byTab[tabKey]
                    if (e?.discard) e.discard()
                    else setDiscardSignal((n) => n + 1)
                  }}
                />
              ) : channel === 'AMAZON' && amazonCockpitMode === 'cockpit' ? (
                /* AC.1 — Route Amazon through the Listing Cockpit when
                   the operator hasn't opted out. The cockpit embeds
                   ChannelListingTab (channel=AMAZON, AG-series grouped
                   form) as a transitional pass-through, so no Amazon
                   functionality is lost while AC.4–AC.10 cards land.
                   The /products/amazon-flat-file surface is untouched
                   — the cockpit reuses the same template manifest
                   endpoint and the same Listing records. */
                <AmazonCockpit
                  key={`${channel}_${selectedMarket}_${discardSignal}_cockpit`}
                  product={product}
                  marketplace={selectedMarket}
                  marketInfo={marketInfo}
                  siblingMarkets={channelMarkets.filter((m) => m.code !== selectedMarket)}
                  siblingListings={(clientListings[channel] ?? []).filter(
                    (l: Listing) => l.marketplace !== selectedMarket,
                  )}
                  listing={listing}
                  onDirtyChange={(count) => setTabDirty(tabKey, count)}
                  onSave={() => router.refresh()}
                  onRegister={(handlers) =>
                    registry.register(tabKey, {
                      label: t('products.edit.discardScopeChannel', {
                        channel,
                        marketplace: selectedMarket,
                      }),
                      ...handlers,
                    })
                  }
                  childrenList={childrenList}
                  /* AC.3 — chip-strip wiring. */
                  onMarketSwitch={(code) => goToCoordinate(channel, code)}
                  getDirtyForMarket={(code) =>
                    dirtyByTab[`channel:${channel}:${code}`] ?? 0
                  }
                  flushActiveMarket={async () => {
                    const e = registry.byTab[tabKey]
                    if (e?.flush) await e.flush()
                  }}
                  discardActiveMarket={() => {
                    const e = registry.byTab[tabKey]
                    if (e?.discard) e.discard()
                    else setDiscardSignal((n) => n + 1)
                  }}
                />
              ) : (
                <>
                  {channel === 'EBAY' && (
                    <ClassicToCockpitBanner />
                  )}
                  {channel === 'AMAZON' && (
                    <ClassicToAmazonCockpitBanner />
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
                  siblingMarkets={channelMarkets.filter((m) => m.code !== selectedMarket)}
                  listing={listing}
                  onDirtyChange={(count) => setTabDirty(tabKey, count)}
                  onSave={() => router.refresh()}
                  onRegister={(handlers) =>
                    registry.register(tabKey, {
                      label: t('products.edit.discardScopeChannel', {
                        channel,
                        marketplace: selectedMarket,
                      }),
                      ...handlers,
                    })
                  }
                  childrenList={childrenList}
                />
                </>
              )}
            </div>
          )
        })()}
      </main>

      {/* TC.5 / TC.6 — Customize Tabs modal. Mounted at root so its
          portal escapes the sticky header / scroll container. */}
      <TabPreferencesModal
        open={tabsModalOpen}
        onClose={() => setTabsModalOpen(false)}
        value={orderedPrefs}
        onSave={(next) => setOrderedPrefs(next)}
        onNavigateToTab={(key, autoPinned) => {
          setOrderedPrefs(autoPinned)
          goToTab(key)
        }}
      />
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
  pinned = true,
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
  /** TC.9 — when false, the tab is rendered as a session-only
   *  visitor (operator is viewing it via URL deep-link or modal
   *  navigation but it isn't in their pinned set). Visual cue: dashed
   *  border-bottom + faded text. Click handler unchanged — the
   *  operator can re-pin via the Customize Tabs modal if desired. */
  pinned?: boolean
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
          ? pinned
            ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
            // TC.9 — active-but-not-pinned: dashed border-bottom +
            // faded text so the operator knows this tab isn't in
            // their saved strip.
            : 'border-blue-400/60 border-dashed text-blue-500/70 dark:border-blue-400/50 dark:text-blue-300/70'
          : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
      )}
      title={pinned ? undefined : 'Not in your pinned tabs — open Customize Tabs to pin'}
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

// EC.1 — Surfaces a one-click return path to the cockpit when an
// operator has opted into classic view. Lives in this file (vs the
// cockpit folder) because it's mounted on the classic-render branch
// of the eBay channel tab — keeping it co-located with the mount
// site avoids a circular import path on ChannelListingTab.
function ClassicToCockpitBanner() {
  const [, setMode] = useCockpitMode()
  return (
    <div className="mb-3 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 flex items-center justify-between gap-3 text-sm">
      <span className="text-blue-800 dark:text-blue-300">
        You&apos;re viewing the classic eBay tab. The new Listing Cockpit
        is available with live preview, dynamic aspects, and a visual
        variation matrix.
      </span>
      <button
        type="button"
        onClick={() => setMode('cockpit')}
        className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
      >
        Switch to Cockpit
      </button>
    </div>
  )
}

// AC.1 — Sibling banner for the Amazon classic-render branch. Same
// rationale as the eBay variant; separate hook so the choice is
// per-channel.
function ClassicToAmazonCockpitBanner() {
  const [, setMode] = useAmazonCockpitMode()
  return (
    <div className="mb-3 px-3 py-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 flex items-center justify-between gap-3 text-sm">
      <span className="text-blue-800 dark:text-blue-300">
        You&apos;re viewing the classic Amazon tab. The new Listing Cockpit
        is available with live PDP preview, pre-publish health, variation
        matrix, and one-click multi-market publish.
      </span>
      <button
        type="button"
        onClick={() => setMode('cockpit')}
        className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
      >
        Switch to Cockpit
      </button>
    </div>
  )
}
