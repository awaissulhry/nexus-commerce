'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home,
  Package,
  Layers,
  FileSpreadsheet,
  Boxes,
  ChevronRight,
  ChevronDown,
  ShoppingBag,
  FileText,
  Tag,
  BarChart3,
  Activity,
  HeartPulse,
  Plug,
  Settings,
  Search,
  Plus,
  Warehouse,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  Truck,
  Undo2,
  Megaphone,
  Target,
  Image as ImageIcon,
  Star,
  FileEdit,
  Sun,
  Moon,
  Monitor,
  type LucideIcon,
} from 'lucide-react'
import { useTheme } from '@/lib/theme/use-theme'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useRecentlyViewed } from '@/lib/use-recently-viewed'
import MarketsModal from './MarketsModal'

interface SidebarCounts {
  catalog?: { products?: number; pimPending?: number }
  listings?: {
    total?: number
    byChannel?: Record<string, { total: number; markets: Record<string, number> }>
  }
  operations?: { pendingOrders?: number }
  monitoring?: { syncIssues?: number }
  system?: { connectedChannels?: number }
}

const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
  NL: 'Netherlands',
  SE: 'Sweden',
  PL: 'Poland',
  BE: 'Belgium',
  AT: 'Austria',
  CH: 'Switzerland',
  IE: 'Ireland',
  TR: 'Turkey',
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
  BR: 'Brazil',
  AE: 'UAE',
  SA: 'Saudi Arabia',
  JP: 'Japan',
  AU: 'Australia',
  HK: 'Hong Kong',
  SG: 'Singapore',
  MY: 'Malaysia',
  GLOBAL: 'Global',
}

// Sidebar shows the priority markets first (Xavia's primaries: EU
// core minus US since US is a different language and lower priority
// for an Italian motorcycle-gear brand). The "See all" modal exposes
// the full SUPPORTED_MARKETS list grouped by region.
const PRIORITY_MARKETS: Record<string, string[]> = {
  AMAZON: ['IT', 'DE', 'FR', 'ES', 'UK'],
  EBAY: ['IT', 'DE', 'FR', 'ES', 'UK'],
}

// Full list of marketplaces each channel supports. Surfaced via the
// modal; the sidebar shows only the priority subset above by default.
const SUPPORTED_MARKETS: Record<string, string[]> = {
  AMAZON: [
    'IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'SE', 'PL', 'BE', 'TR',
    'US', 'CA', 'MX', 'BR',
    'AE', 'SA',
    'JP', 'AU',
  ],
  EBAY: [
    'IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'AT', 'CH', 'IE', 'PL',
    'US', 'CA',
    'AU', 'HK', 'SG', 'MY',
  ],
}

const EXPAND_STATE_KEY = 'sidebar:expandedChannels'

export default function AppSidebar() {
  const pathname = usePathname() ?? '/'
  const [counts, setCounts] = useState<SidebarCounts>({})
  // H.9 — mobile drawer state. Listens for a custom event so the
  // hamburger button in the layout can toggle without prop drilling.
  // Auto-closes on every pathname change so a nav click both routes
  // and dismisses the drawer in one gesture.
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => {
    const onToggle = () => setMobileOpen((v) => !v)
    const onClose = () => setMobileOpen(false)
    window.addEventListener('nexus:toggle-sidebar', onToggle)
    window.addEventListener('nexus:close-sidebar', onClose)
    return () => {
      window.removeEventListener('nexus:toggle-sidebar', onToggle)
      window.removeEventListener('nexus:close-sidebar', onClose)
    }
  }, [])
  // Close on route change.
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])
  // SSR-safe init: default Amazon-expanded; useEffect below rehydrates
  // from localStorage so the user's last expand/collapse state persists
  // across page navigations.
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(
    new Set(['AMAZON']),
  )
  const [ebayConnected, setEbayConnected] = useState(false)
  const [amazonConnected, setAmazonConnected] = useState(false)
  const recent = useRecentlyViewed()

  // Hydrate expand state from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EXPAND_STATE_KEY)
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        if (Array.isArray(arr)) setExpandedChannels(new Set(arr))
      }
    } catch {
      /* localStorage unavailable / parse failure → keep default */
    }
  }, [])

  // Fetch the unified connection list once. The /api/connections
  // endpoint returns one row per supported channel — Amazon
  // synthesised from env vars (isManagedBy='env'), eBay from the
  // OAuth-backed table, the rest as 'pending' placeholders. We only
  // render the dot for AMAZON and EBAY today; Shopify/Woo are
  // hardcoded as `indicator="disconnected"` until their adapters
  // ship.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/connections`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const list = (data.connections ?? []) as Array<{
          channel: string
          isActive: boolean
        }>
        setEbayConnected(list.some((c) => c.channel === 'EBAY' && c.isActive))
        setAmazonConnected(
          list.some((c) => c.channel === 'AMAZON' && c.isActive),
        )
      })
      .catch(() => {
        /* swallow — sidebar must never crash the shell */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Stable reference so the C.2 invalidation listener below can drive
  // a refetch the same way the polling interval does.
  const cancelledRef = useRef(false)
  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/sidebar/counts`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = (await res.json()) as SidebarCounts
      if (!cancelledRef.current) setCounts(data)
    } catch {
      /* sidebar should never crash the shell */
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    fetchCounts()
    const id = window.setInterval(fetchCounts, 60_000)
    // Refetch when the user returns to the tab — covers the "I left
    // this open overnight" case where the polling interval kept
    // ticking but the data is now stale relative to what they'd
    // expect on focus.
    const onFocus = () => fetchCounts()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelledRef.current = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchCounts])

  // C.2 — refresh sidebar counts within ~300ms of any listing/product
  // mutation, instead of waiting for the next 60s polling tick. Burst
  // events (e.g. a 1000-listing bulk publish firing one
  // `listing.created` per item) are coalesced by the trailing-edge
  // debounce so we make at most one /api/sidebar/counts call per
  // user-perceived action. listing.updated is intentionally NOT
  // listened to — it fires on every cell edit and never changes the
  // count totals the sidebar surfaces.
  const refetchTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (refetchTimerRef.current !== null) {
        window.clearTimeout(refetchTimerRef.current)
        refetchTimerRef.current = null
      }
    },
    [],
  )
  const debouncedRefetch = useCallback(() => {
    if (typeof window === 'undefined') return
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current)
    }
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null
      void fetchCounts()
    }, 300)
  }, [fetchCounts])
  useInvalidationChannel(
    [
      'listing.created',
      'listing.deleted',
      'wizard.submitted',
      'bulk-job.completed',
      'product.created',
      'product.deleted',
    ],
    debouncedRefetch,
  )

  const toggleChannel = (channel: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(channel)) next.delete(channel)
      else next.add(channel)
      try {
        window.localStorage.setItem(
          EXPAND_STATE_KEY,
          JSON.stringify(Array.from(next)),
        )
      } catch {
        /* ignore — storage quota / privacy mode */
      }
      return next
    })
  }

  const dispatchCmdK = () => {
    window.dispatchEvent(new CustomEvent('nexus:open-command-palette'))
  }

  return (
    <>
      {/* H.9 — mobile backdrop. Tap to close. md:hidden so it never
          renders on desktop where the sidebar is part of flex flow. */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 bg-slate-900/50 z-30 md:hidden"
          aria-hidden
        />
      )}
      <aside
        className={`w-60 bg-slate-900 flex flex-col h-screen border-r border-slate-800 flex-shrink-0 transition-transform duration-200 ease-out
          fixed top-0 left-0 z-40 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          md:sticky md:translate-x-0 md:z-auto md:flex`}
      >
      {/* ── Logo + ⌘K ────────────────────────────────────────── */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-800 flex-shrink-0">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white text-base font-bold leading-none">N</span>
          </div>
          <span className="text-lg font-semibold text-white">Nexus</span>
        </Link>
        <div className="flex items-center gap-1">
          {/* U.14 — theme toggle. Sits next to the ⌘K search button so
              the chrome row stays compact. The toggle is dark-aware
              itself via dark: variants. */}
          <SidebarThemeToggle />
          <button
            type="button"
            onClick={dispatchCmdK}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800 transition-colors"
            title="Search (⌘K)"
          >
            <Search className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Workspace switcher ──────────────────────────────── */}
      <div className="px-3 py-2.5 border-b border-slate-800 flex-shrink-0">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left hover:bg-slate-800 rounded-md px-2 py-1.5 transition-colors"
        >
          <div className="min-w-0">
            <div className="text-base font-medium text-white truncate">Xavia Racing</div>
            <div className="text-xs text-slate-400 truncate">Workspace</div>
          </div>
          <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
        </button>
      </div>

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-3">
        <NavItem href="/" icon={Home} label="Home" active={pathname === '/'} />

        <NavGroup label="Catalog">
          <NavItem
            href="/products"
            icon={Package}
            label="Products"
            count={counts.catalog?.products}
            active={
              pathname === '/products' ||
              (pathname.startsWith('/products/') &&
                pathname !== '/products/drafts') ||
              pathname === '/inventory' ||
              pathname.startsWith('/inventory/')
            }
          />
          <NavItem
            href="/products/drafts"
            icon={FileEdit}
            label="Drafts"
            active={pathname === '/products/drafts'}
          />
          <NavItem
            href="/catalog/organize"
            icon={Layers}
            label="Organize"
            count={counts.catalog?.pimPending}
            indicator={
              (counts.catalog?.pimPending ?? 0) > 0 ? 'warning' : undefined
            }
            active={pathname.startsWith('/catalog/organize')}
          />
          <NavItem
            href="/bulk-operations"
            icon={FileSpreadsheet}
            label="Bulk Operations"
            active={
              pathname === '/bulk-operations' ||
              pathname.startsWith('/bulk-operations/')
            }
          />
        </NavGroup>

        <NavGroup label="Syndication">
          <NavItem
            href="/listings"
            icon={Boxes}
            label="All Listings"
            count={counts.listings?.total}
            active={pathname === '/listings'}
          />
          <ChannelNav
            channel="AMAZON"
            label="Amazon"
            count={counts.listings?.byChannel?.AMAZON?.total}
            markets={counts.listings?.byChannel?.AMAZON?.markets}
            priorityMarkets={PRIORITY_MARKETS.AMAZON}
            supportedMarkets={SUPPORTED_MARKETS.AMAZON}
            countryNames={COUNTRY_NAMES}
            connectionStatus={amazonConnected ? 'connected' : 'not-connected'}
            expanded={expandedChannels.has('AMAZON')}
            onToggle={() => toggleChannel('AMAZON')}
            pathname={pathname}
          />
          <ChannelNav
            channel="EBAY"
            label="eBay"
            count={counts.listings?.byChannel?.EBAY?.total}
            markets={counts.listings?.byChannel?.EBAY?.markets}
            priorityMarkets={PRIORITY_MARKETS.EBAY}
            supportedMarkets={SUPPORTED_MARKETS.EBAY}
            countryNames={COUNTRY_NAMES}
            connectionStatus={ebayConnected ? 'connected' : 'not-connected'}
            expanded={expandedChannels.has('EBAY')}
            onToggle={() => toggleChannel('EBAY')}
            pathname={pathname}
          />
          <NavItem
            href="/listings/shopify"
            icon={ShoppingBag}
            label="Shopify"
            indicator="disconnected"
            active={pathname.startsWith('/listings/shopify')}
          />
          <NavItem
            href="/listings/woocommerce"
            icon={ShoppingBag}
            label="WooCommerce"
            indicator="disconnected"
            active={pathname.startsWith('/listings/woocommerce')}
          />
        </NavGroup>

        <NavGroup label="Fulfillment">
          <NavItem
            href="/fulfillment/stock"
            icon={Warehouse}
            label="Stock Overview"
            active={pathname === '/fulfillment/stock'}
          />
          <NavItem
            href="/fulfillment/inbound"
            icon={PackageCheck}
            label="Inbound Shipments"
            active={pathname === '/fulfillment/inbound'}
          />
          <NavItem
            href="/fulfillment/outbound"
            icon={PackageOpen}
            label="Outbound Shipments"
            // O.22: same pending-orders count drives both the Orders
            // entry and the Outbound entry — pending-orders == orders
            // that need a shipment created. Operators expect the same
            // number to appear in both places.
            count={counts.operations?.pendingOrders}
            indicator={
              (counts.operations?.pendingOrders ?? 0) > 0 ? 'action' : undefined
            }
            active={pathname === '/fulfillment/outbound' || pathname.startsWith('/fulfillment/outbound/')}
          />
          <NavItem
            href="/fulfillment/replenishment"
            icon={RefreshCw}
            label="Smart Replenishment"
            active={pathname === '/fulfillment/replenishment'}
          />
          <NavItem
            href="/fulfillment/carriers"
            icon={Truck}
            label="Carriers"
            active={pathname === '/fulfillment/carriers'}
          />
          <NavItem
            href="/fulfillment/returns"
            icon={Undo2}
            label="Returns"
            active={pathname === '/fulfillment/returns'}
          />
        </NavGroup>

        <NavGroup label="Marketing">
          <NavItem
            href="/marketing/promotions"
            icon={Megaphone}
            label="Promotions"
            active={pathname === '/marketing/promotions'}
          />
          <NavItem
            href="/marketing/advertising"
            icon={Target}
            label="Advertising"
            active={pathname === '/marketing/advertising'}
          />
          <NavItem
            href="/marketing/content"
            icon={ImageIcon}
            label="Content Hub"
            active={pathname === '/marketing/content'}
          />
          <NavItem
            href="/marketing/reviews"
            icon={Star}
            label="Reviews"
            active={pathname === '/marketing/reviews'}
          />
        </NavGroup>

        <NavGroup label="Operations">
          <NavItem
            href="/orders"
            icon={FileText}
            label="Orders"
            count={counts.operations?.pendingOrders}
            indicator={
              (counts.operations?.pendingOrders ?? 0) > 0 ? 'action' : undefined
            }
            active={pathname.startsWith('/orders')}
          />
          <NavItem
            href="/pricing"
            icon={Tag}
            label="Pricing"
            active={pathname.startsWith('/pricing')}
          />
          <NavItem
            href="/insights"
            icon={BarChart3}
            label="Insights"
            active={
              pathname.startsWith('/insights') ||
              pathname === '/dashboard/overview'
            }
          />
        </NavGroup>

        <NavGroup label="Monitoring">
          <NavItem
            href="/sync-logs"
            icon={Activity}
            label="Activity Log"
            active={pathname === '/sync-logs' || pathname === '/logs'}
          />
          <NavItem
            href="/dashboard/health"
            icon={HeartPulse}
            label="Sync Health"
            indicator={
              (counts.monitoring?.syncIssues ?? 0) > 0 ? 'warning' : undefined
            }
            active={pathname === '/dashboard/health'}
          />
        </NavGroup>

        <NavGroup label="System">
          <NavItem
            href="/settings/channels"
            icon={Plug}
            label="Connections"
            count={counts.system?.connectedChannels}
            active={pathname.startsWith('/settings/channels')}
          />
          <NavItem
            href="/settings/account"
            icon={Settings}
            label="Settings"
            active={
              pathname === '/settings' ||
              (pathname.startsWith('/settings/') &&
                !pathname.startsWith('/settings/channels'))
            }
          />
        </NavGroup>
      </nav>

      {/* ── Recently viewed ──────────────────────────────────── */}
      <div className="border-t border-slate-800 px-4 py-3 flex-shrink-0">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
          Recently viewed
        </div>
        {recent.length === 0 ? (
          <div className="text-sm text-slate-500">No recent items</div>
        ) : (
          <ul className="space-y-1">
            {recent.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="block text-sm text-slate-400 hover:text-white truncate transition-colors"
                  title={item.label}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── User ─────────────────────────────────────────────── */}
      <div className="border-t border-slate-800 p-3 flex-shrink-0">
        <button
          type="button"
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-slate-800 transition-colors"
        >
          <div className="w-7 h-7 bg-slate-700 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-sm font-medium text-white">A</span>
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-base font-medium text-white truncate">Awa</div>
            <div className="text-sm text-slate-400 truncate">Xavia Racing</div>
          </div>
        </button>
      </div>
      </aside>
    </>
  )
}

// ── Helpers ───────────────────────────────────────────────────

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-4 mb-1">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          {label}
        </h3>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

interface NavItemProps {
  href: string
  icon?: LucideIcon
  label: string
  count?: number
  indicator?: 'action' | 'warning' | 'disconnected'
  active?: boolean
}

function NavItem({ href, icon: Icon, label, count, indicator, active }: NavItemProps) {
  const dotClass =
    indicator === 'action'
      ? 'bg-red-500'
      : indicator === 'warning'
      ? 'bg-amber-500'
      : ''

  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-md text-md transition-colors group',
        active
          ? 'bg-blue-600 text-white font-medium'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white',
        indicator === 'disconnected' && 'opacity-60 hover:opacity-100'
      )}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      <span className="flex-1 truncate">{label}</span>

      {indicator === 'disconnected' ? (
        <span className="text-xs text-slate-500 group-hover:text-slate-300">
          Connect
        </span>
      ) : (
        <>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                'text-xs tabular-nums px-1.5 py-0.5 rounded',
                active
                  ? 'bg-blue-700 text-blue-100'
                  : 'bg-slate-800 text-slate-400'
              )}
            >
              {count}
            </span>
          )}
          {dotClass && <span className={cn('w-1.5 h-1.5 rounded-full', dotClass)} />}
        </>
      )}
    </Link>
  )
}

interface ChannelNavProps {
  channel: string
  label: string
  count?: number
  markets?: Record<string, number>
  /** Markets to render directly in the sidebar dropdown (typically
   *  5). Order is the priority order — first in the array shows
   *  first. */
  priorityMarkets?: string[]
  /** Full set of markets this channel supports. Shown in the
   *  "All markets" modal. Always a superset of priorityMarkets. */
  supportedMarkets?: string[]
  /** Country-name lookup. Passed in so the modal doesn't have to
   *  duplicate it. */
  countryNames?: Record<string, string>
  /** Per-channel connection state. Currently only eBay surfaces this
   *  (single OAuth token covers all eBay marketplaces). When set,
   *  controls the status dot colour per marketplace. */
  connectionStatus?: 'connected' | 'not-connected'
  expanded: boolean
  onToggle: () => void
  pathname: string
}

function ChannelNav({
  channel,
  label,
  count,
  markets,
  priorityMarkets,
  supportedMarkets,
  countryNames,
  connectionStatus,
  expanded,
  onToggle,
  pathname,
}: ChannelNavProps) {
  const channelPath = `/listings/${channel.toLowerCase()}`
  const isOnChannel = pathname.startsWith(channelPath)
  const [modalOpen, setModalOpen] = useState(false)

  // The full set used by the modal: every supported market with its
  // real listing count merged in.
  const fullMarkets = new Map<string, number>()
  for (const code of supportedMarkets ?? []) fullMarkets.set(code, 0)
  for (const [code, n] of Object.entries(markets ?? {})) {
    fullMarkets.set(code, n as number)
  }

  // The inline subset rendered in the sidebar: priority markets only.
  // Inline list deliberately stays small — the modal handles the long
  // tail. If priorityMarkets isn't provided, fall back to the first
  // few supported markets.
  const inlineCodes = priorityMarkets ?? (supportedMarkets ?? []).slice(0, 5)
  const inlineMarkets: Array<[string, number]> = inlineCodes.map((code) => [
    code,
    fullMarkets.get(code) ?? 0,
  ])
  const hasMarkets = fullMarkets.size > 0
  const hasOverflow = fullMarkets.size > inlineCodes.length

  return (
    <div>
      {/* Two-target row: name area is a Link to the channel landing
          page; the chevron is a separate button that toggles expand.
          Click the platform → navigate. Click the chevron → expand.
          Visually unified via the parent flex container's hover
          state. */}
      <div
        className={cn(
          'flex items-center mx-2 rounded-md transition-colors',
          isOnChannel ? 'bg-blue-600' : 'hover:bg-slate-800',
        )}
      >
        <Link
          href={channelPath}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2.5 px-3 py-1.5 text-md rounded-l-md',
            isOnChannel
              ? 'text-white font-medium'
              : 'text-slate-300 hover:text-white',
            !hasMarkets && (isOnChannel ? '' : 'rounded-r-md'),
          )}
        >
          <ShoppingBag className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 truncate text-left">{label}</span>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                'text-xs tabular-nums px-1.5 py-0.5 rounded',
                isOnChannel
                  ? 'bg-blue-700 text-blue-100'
                  : 'bg-slate-800 text-slate-400',
              )}
            >
              {count}
            </span>
          )}
        </Link>
        {hasMarkets && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} marketplaces`}
            aria-expanded={expanded}
            className={cn(
              'flex-shrink-0 px-2 py-1.5 rounded-r-md transition-colors',
              isOnChannel
                ? 'text-blue-100 hover:bg-blue-700'
                : 'text-slate-400 hover:bg-slate-700/60 hover:text-white',
            )}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {expanded && hasMarkets && (
        <div className="mt-0.5 space-y-0.5">
          {inlineMarkets.map(([code, mcount]) => {
            const marketHref = `${channelPath}/${code.toLowerCase()}`
            const active = pathname === marketHref
            // Status dot: only meaningful when connectionStatus is
            // provided (eBay today). For Amazon we don't have a
            // per-channel connection state, so leave the dot off.
            const dotClass =
              connectionStatus === 'connected'
                ? mcount > 0
                  ? 'bg-emerald-500' // connected + has listings
                  : 'bg-amber-500' // connected, 0 listings yet
                : connectionStatus === 'not-connected'
                  ? 'bg-slate-600'
                  : null

            return (
              <Link
                key={code}
                href={marketHref}
                className={cn(
                  'flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-base transition-colors',
                  active
                    ? 'bg-blue-600/30 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                )}
              >
                {dotClass && (
                  <span
                    className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass)}
                    aria-hidden="true"
                  />
                )}
                <span className="font-mono text-xs font-semibold bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                  {code}
                </span>
                <span className="flex-1 truncate">
                  {countryNames?.[code] ?? COUNTRY_NAMES[code] ?? code}
                </span>
                {connectionStatus === 'not-connected' ? (
                  <span className="text-xs text-slate-500">—</span>
                ) : mcount > 0 ? (
                  <span className="text-xs tabular-nums text-slate-500">
                    {mcount}
                  </span>
                ) : (
                  <span className="text-xs text-slate-600">0</span>
                )}
              </Link>
            )
          })}
          {hasOverflow && (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="w-[calc(100%-16px)] flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-sm text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
            >
              <Search className="w-3 h-3" />
              <span>See all {fullMarkets.size} markets</span>
            </button>
          )}
          {connectionStatus === 'not-connected' ? (
            <Link
              href="/settings/channels"
              className="flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-sm text-blue-400 hover:bg-slate-800 hover:text-blue-300 transition-colors"
            >
              <Plug className="w-3 h-3" />
              <span>Connect {label}</span>
            </Link>
          ) : (
            <Link
              href={`${channelPath}/add-market`}
              className="flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-sm text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
            >
              <Plus className="w-3 h-3" />
              <span>Add Market</span>
            </Link>
          )}
        </div>
      )}

      <MarketsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        channelLabel={label}
        channelPath={channelPath}
        markets={fullMarkets}
        countryNames={countryNames ?? COUNTRY_NAMES}
        connectionStatus={connectionStatus}
      />
    </div>
  )
}

/**
 * U.14 — sidebar-styled theme toggle. The sidebar is always dark
 * regardless of app theme, so this variant uses fixed slate-on-dark
 * colors instead of dark: variants.
 */
function SidebarThemeToggle() {
  const { mode, cycleTheme } = useTheme()
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const nextLabel =
    mode === 'light'
      ? 'Switch to dark mode'
      : mode === 'dark'
        ? 'Switch to system theme'
        : 'Switch to light mode'
  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={nextLabel}
      aria-label={nextLabel}
      className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800 transition-colors"
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}
