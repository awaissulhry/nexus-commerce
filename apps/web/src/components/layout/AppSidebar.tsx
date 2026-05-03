'use client'

import { useEffect, useState, type ReactNode } from 'react'
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
  ChevronUp,
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
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useRecentlyViewed } from '@/lib/use-recently-viewed'

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
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
  GLOBAL: 'Global',
}

// Channels and the marketplaces we support listing to. Surfacing
// these statically (rather than deriving from existing listings)
// lets the sidebar show all destinations even when zero listings
// exist — important right after OAuth completes, before anything
// has been published.
const SUPPORTED_MARKETS: Record<string, string[]> = {
  AMAZON: ['IT', 'DE', 'FR', 'ES', 'UK', 'US', 'NL', 'SE', 'PL', 'CA', 'MX'],
  EBAY: ['IT', 'DE', 'FR', 'ES', 'UK', 'US'],
}

const EXPAND_STATE_KEY = 'sidebar:expandedChannels'

// Compact-by-default. Channels with > MAX_VISIBLE + 1 markets show
// the top N and a "See all" link (Linear/Vercel/Stripe pattern). The
// "+ 1" rule avoids "See all 6" that hides only one row — when the
// hidden count is ≤ 1 we just show everything.
const MAX_VISIBLE_MARKETS = 5

export default function AppSidebar() {
  const pathname = usePathname() ?? '/'
  const [counts, setCounts] = useState<SidebarCounts>({})
  // SSR-safe init: default Amazon-expanded; useEffect below rehydrates
  // from localStorage so the user's last expand/collapse state persists
  // across page navigations.
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(
    new Set(['AMAZON']),
  )
  const [ebayConnected, setEbayConnected] = useState(false)
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

  // Fetch eBay connection status once. The /api/ebay/auth/connections
  // endpoint returns all rows; ANY active row means the user can
  // publish to any eBay marketplace they're registered for (eBay
  // OAuth is single-token / multi-marketplace, unlike Amazon SP-API).
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/ebay/auth/connections`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const list = (data.connections ?? []) as Array<{ isActive?: boolean }>
        setEbayConnected(list.some((c) => c.isActive === true))
      })
      .catch(() => {
        /* swallow — sidebar must never crash the shell */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const fetchCounts = async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/sidebar/counts`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const data = (await res.json()) as SidebarCounts
        if (!cancelled) setCounts(data)
      } catch {
        /* sidebar should never crash the shell */
      }
    }
    fetchCounts()
    const id = window.setInterval(fetchCounts, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

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
    <aside className="w-60 bg-slate-900 flex flex-col h-screen sticky top-0 border-r border-slate-800 flex-shrink-0">
      {/* ── Logo + ⌘K ────────────────────────────────────────── */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-800 flex-shrink-0">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white text-[12px] font-bold leading-none">N</span>
          </div>
          <span className="text-[14px] font-semibold text-white">Nexus</span>
        </Link>
        <button
          type="button"
          onClick={dispatchCmdK}
          className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800 transition-colors"
          title="Search (⌘K)"
        >
          <Search className="w-4 h-4" />
        </button>
      </div>

      {/* ── Workspace switcher ──────────────────────────────── */}
      <div className="px-3 py-2.5 border-b border-slate-800 flex-shrink-0">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left hover:bg-slate-800 rounded-md px-2 py-1.5 transition-colors"
        >
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-white truncate">Xavia Racing</div>
            <div className="text-[10px] text-slate-400 truncate">Workspace</div>
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
              pathname.startsWith('/products/') ||
              pathname === '/inventory' ||
              pathname.startsWith('/inventory/')
            }
          />
          <NavItem
            href="/pim/review"
            icon={Layers}
            label="PIM Review"
            count={counts.catalog?.pimPending}
            indicator={
              (counts.catalog?.pimPending ?? 0) > 0 ? 'warning' : undefined
            }
            active={pathname.startsWith('/pim')}
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
            supportedMarkets={SUPPORTED_MARKETS.AMAZON}
            expanded={expandedChannels.has('AMAZON')}
            onToggle={() => toggleChannel('AMAZON')}
            pathname={pathname}
          />
          <ChannelNav
            channel="EBAY"
            label="eBay"
            count={counts.listings?.byChannel?.EBAY?.total}
            markets={counts.listings?.byChannel?.EBAY?.markets}
            supportedMarkets={SUPPORTED_MARKETS.EBAY}
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
            active={pathname === '/fulfillment/outbound'}
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
        <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
          Recently viewed
        </div>
        {recent.length === 0 ? (
          <div className="text-[11px] text-slate-500">No recent items</div>
        ) : (
          <ul className="space-y-1">
            {recent.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="block text-[11px] text-slate-400 hover:text-white truncate transition-colors"
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
            <span className="text-[11px] font-medium text-white">A</span>
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12px] font-medium text-white truncate">Awa</div>
            <div className="text-[11px] text-slate-400 truncate">Xavia Racing</div>
          </div>
        </button>
      </div>
    </aside>
  )
}

// ── Helpers ───────────────────────────────────────────────────

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-4 mb-1">
        <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
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
        'flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-md text-[13px] transition-colors group',
        active
          ? 'bg-blue-600 text-white font-medium'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white',
        indicator === 'disconnected' && 'opacity-60 hover:opacity-100'
      )}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      <span className="flex-1 truncate">{label}</span>

      {indicator === 'disconnected' ? (
        <span className="text-[10px] text-slate-500 group-hover:text-slate-300">
          Connect
        </span>
      ) : (
        <>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                'text-[10px] tabular-nums px-1.5 py-0.5 rounded',
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
  /** Statically declared marketplaces this channel supports. Merged
   *  with `markets` (real listing counts) so destinations always
   *  appear in the dropdown even when no listings exist yet. */
  supportedMarkets?: string[]
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
  supportedMarkets,
  connectionStatus,
  expanded,
  onToggle,
  pathname,
}: ChannelNavProps) {
  const channelPath = `/listings/${channel.toLowerCase()}`
  const isOnChannel = pathname.startsWith(channelPath)
  // Per-channel "show all markets" toggle is intentionally NOT
  // persisted — the sidebar should default to its compact state on
  // every page load. expand/collapse of the channel itself is
  // persisted (see EXPAND_STATE_KEY in the parent), but density
  // resets so users never land on a 100-row sidebar.
  const [showAllMarkets, setShowAllMarkets] = useState(false)

  // Merge supported markets (always show) with real listing counts.
  // Supported markets default to count 0 so the user sees them
  // immediately after OAuth, before any publish has happened.
  const mergedMarkets = new Map<string, number>()
  for (const code of supportedMarkets ?? []) mergedMarkets.set(code, 0)
  for (const [code, n] of Object.entries(markets ?? {})) {
    mergedMarkets.set(code, n as number)
  }
  const allMarketEntries = Array.from(mergedMarkets.entries())
  const hasMarkets = allMarketEntries.length > 0
  // If hiding ≤ 1 row, just show everything — "See all 6" hiding 1
  // would be silly. Threshold = MAX_VISIBLE + 1 (so 6 stays inline,
  // 7+ gets the overflow treatment).
  const overflowThreshold = MAX_VISIBLE_MARKETS + 1
  const needsOverflow = allMarketEntries.length > overflowThreshold
  const visibleMarkets =
    !needsOverflow || showAllMarkets
      ? allMarketEntries
      : allMarketEntries.slice(0, MAX_VISIBLE_MARKETS)

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
            'flex-1 min-w-0 flex items-center gap-2.5 px-3 py-1.5 text-[13px] rounded-l-md',
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
                'text-[10px] tabular-nums px-1.5 py-0.5 rounded',
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
          {visibleMarkets.map(([code, mcount]) => {
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
                  'flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[12px] transition-colors',
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
                <span className="font-mono text-[10px] font-semibold bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                  {code}
                </span>
                <span className="flex-1 truncate">{COUNTRY_NAMES[code] ?? code}</span>
                {connectionStatus === 'not-connected' ? (
                  <span className="text-[10px] text-slate-500">—</span>
                ) : mcount > 0 ? (
                  <span className="text-[10px] tabular-nums text-slate-500">
                    {mcount}
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-600">0</span>
                )}
              </Link>
            )
          })}
          {needsOverflow &&
            (showAllMarkets ? (
              <button
                type="button"
                onClick={() => setShowAllMarkets(false)}
                className="w-[calc(100%-16px)] flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
              >
                <ChevronUp className="w-3 h-3" />
                <span>Show fewer</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowAllMarkets(true)}
                className="w-[calc(100%-16px)] flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
              >
                <ChevronDown className="w-3 h-3" />
                <span>
                  See all {allMarketEntries.length} markets
                </span>
              </button>
            ))}
          {connectionStatus === 'not-connected' ? (
            <Link
              href="/settings/channels"
              className="flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[11px] text-blue-400 hover:bg-slate-800 hover:text-blue-300 transition-colors"
            >
              <Plug className="w-3 h-3" />
              <span>Connect {label}</span>
            </Link>
          ) : (
            <Link
              href={`${channelPath}/add-market`}
              className="flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
            >
              <Plus className="w-3 h-3" />
              <span>Add Market</span>
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
