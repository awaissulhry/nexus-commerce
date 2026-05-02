'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home,
  Package,
  Layers,
  Upload,
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
  GLOBAL: 'Global',
}

export default function AppSidebar() {
  const pathname = usePathname() ?? '/'
  const [counts, setCounts] = useState<SidebarCounts>({})
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(
    new Set(['AMAZON'])
  )
  const recent = useRecentlyViewed()

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
            href="/inventory"
            icon={Package}
            label="Products"
            count={counts.catalog?.products}
            active={pathname === '/inventory' || pathname.startsWith('/inventory/')}
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
            href="/inventory/upload"
            icon={Upload}
            label="Bulk Upload"
            active={pathname === '/inventory/upload'}
          />
        </NavGroup>

        <NavGroup label="Listings">
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
            expanded={expandedChannels.has('AMAZON')}
            onToggle={() => toggleChannel('AMAZON')}
            pathname={pathname}
          />
          <ChannelNav
            channel="EBAY"
            label="eBay"
            count={counts.listings?.byChannel?.EBAY?.total}
            markets={counts.listings?.byChannel?.EBAY?.markets}
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
            active={pathname.startsWith('/insights')}
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
  expanded: boolean
  onToggle: () => void
  pathname: string
}

function ChannelNav({
  channel,
  label,
  count,
  markets,
  expanded,
  onToggle,
  pathname,
}: ChannelNavProps) {
  const channelPath = `/listings/${channel.toLowerCase()}`
  const isOnChannel = pathname.startsWith(channelPath)
  const hasMarkets = markets && Object.keys(markets).length > 0

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-[calc(100%-16px)] flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-md text-[13px] transition-colors',
          isOnChannel
            ? 'bg-blue-600 text-white font-medium'
            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
        )}
      >
        <ShoppingBag className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 truncate text-left">{label}</span>
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              'text-[10px] tabular-nums px-1.5 py-0.5 rounded mr-1',
              isOnChannel
                ? 'bg-blue-700 text-blue-100'
                : 'bg-slate-800 text-slate-400'
            )}
          >
            {count}
          </span>
        )}
        {hasMarkets &&
          (expanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" />
          ))}
      </button>

      {expanded && hasMarkets && (
        <div className="mt-0.5 space-y-0.5">
          {Object.entries(markets!).map(([code, mcount]) => {
            const marketHref = `${channelPath}/${code.toLowerCase()}`
            const active = pathname === marketHref
            return (
              <Link
                key={code}
                href={marketHref}
                className={cn(
                  'flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[12px] transition-colors',
                  active
                    ? 'bg-blue-600/30 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                )}
              >
                <span className="font-mono text-[10px] font-semibold bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                  {code}
                </span>
                <span className="flex-1 truncate">{COUNTRY_NAMES[code] ?? code}</span>
                <span className="text-[10px] tabular-nums text-slate-500">{mcount}</span>
              </Link>
            )
          })}
          <Link
            href={`${channelPath}/add-market`}
            className="flex items-center gap-2.5 mx-2 ml-9 px-3 py-1 rounded-md text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-300 transition-colors"
          >
            <Plus className="w-3 h-3" />
            <span>Add Market</span>
          </Link>
        </div>
      )}
    </div>
  )
}
