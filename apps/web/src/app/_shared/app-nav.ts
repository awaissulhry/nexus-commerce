/**
 * Canonical application navigation — the single source of truth for the global
 * rail (AppNavRail) and the /products/next preview bed.
 *
 * `buildAppNav(counts, conn)` resolves the static structure into the
 * RailNavItem[] that AppRail renders, merging live counts → badges and
 * thresholds → indicator dots, mirroring components/layout/AppSidebar.tsx so
 * there is no behavioural drift between the two during the migration.
 */
import {
  Home,
  Package,
  Boxes,
  Warehouse,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  ShoppingCart,
  Factory,
  Truck,
  Undo2,
  Megaphone,
  CalendarDays,
  Image as ImageIcon,
  Star,
  FileText,
  Tag,
  BarChart3,
  Inbox,
  Activity,
  Plug,
  Shuffle,
  Settings,
  Trash2,
} from 'lucide-react'
import type { RailNavItem, RailMarketItem } from './AppRail'

/** Shape of GET /api/sidebar/counts (mirrors AppSidebar's SidebarCounts). */
export interface SidebarCounts {
  catalog?: { products?: number; pimPending?: number }
  listings?: {
    total?: number
    byChannel?: Record<string, { total: number; markets: Record<string, number> }>
  }
  operations?: { pendingOrders?: number }
  monitoring?: { syncIssues?: number }
  system?: { connectedChannels?: number }
  inbox?: { critical?: number; warn?: number; total?: number }
}

export interface Connections {
  amazon: boolean
  ebay: boolean
}

const PRIORITY_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
}

function markets(channel: 'amazon' | 'ebay'): RailMarketItem[] {
  return PRIORITY_MARKETS.map((code) => ({
    code,
    label: COUNTRY_NAMES[code],
    href: `/listings/${channel}/${code.toLowerCase()}`,
  }))
}

/** Resolve the canonical nav into render-ready items for AppRail. */
export function buildAppNav(counts: SidebarCounts, conn: Connections): RailNavItem[] {
  // Only surface a badge when the count is a positive number.
  const n = (v?: number) => (v && v > 0 ? v : undefined)

  return [
    { label: 'Home', href: '/', Icon: Home },

    // ── Catalog ──────────────────────────────────────────────────
    {
      label: 'Products',
      href: '/products',
      Icon: Package,
      badge: n(counts.catalog?.products),
      children: [
        { label: 'Matrix', href: '/catalog/matrix' },
        { label: 'Drafts', href: '/products/drafts' },
        {
          label: 'Organize',
          href: '/catalog/organize',
          indicator: (counts.catalog?.pimPending ?? 0) > 0 ? 'warning' : undefined,
        },
        { label: 'Bulk Operations', href: '/bulk-operations' },
      ],
    },

    // ── Syndication ──────────────────────────────────────────────
    {
      label: 'Listings',
      href: '/listings',
      Icon: Boxes,
      badge: n(counts.listings?.total),
      children: [
        {
          label: 'Amazon',
          href: '/listings/amazon',
          indicator: conn.amazon ? undefined : 'disconnected',
          children: markets('amazon'),
        },
        {
          label: 'eBay',
          href: '/listings/ebay',
          indicator: conn.ebay ? undefined : 'disconnected',
          children: markets('ebay'),
        },
        { label: 'Shopify', href: '/listings/shopify' },
      ],
    },

    // ── Fulfillment ──────────────────────────────────────────────
    {
      label: 'Stock',
      href: '/fulfillment/stock',
      Icon: Warehouse,
      children: [{ label: 'Channel Drift', href: '/fulfillment/stock/channel-drift' }],
    },
    { label: 'Inbound', href: '/fulfillment/inbound', Icon: PackageCheck },
    {
      label: 'Outbound',
      href: '/fulfillment/outbound',
      Icon: PackageOpen,
      badge: n(counts.operations?.pendingOrders),
      indicator: (counts.operations?.pendingOrders ?? 0) > 0 ? 'action' : undefined,
      children: [{ label: 'Outbound Analytics', href: '/fulfillment/outbound/analytics' }],
    },
    { label: 'Replenishment', href: '/fulfillment/replenishment', Icon: RefreshCw },
    { label: 'Purchase Orders', href: '/fulfillment/purchase-orders', Icon: ShoppingCart },
    { label: 'Suppliers', href: '/fulfillment/suppliers', Icon: Factory },
    { label: 'Carriers', href: '/fulfillment/carriers', Icon: Truck },
    {
      label: 'Returns',
      href: '/fulfillment/returns',
      Icon: Undo2,
      children: [
        { label: 'Returns Analytics', href: '/fulfillment/returns/analytics' },
        { label: 'Returns Automation', href: '/fulfillment/returns/automation' },
        { label: 'Return Policies', href: '/fulfillment/returns/policies' },
      ],
    },

    // ── Operations ───────────────────────────────────────────────
    {
      label: 'Orders',
      href: '/orders',
      Icon: FileText,
      badge: n(counts.operations?.pendingOrders),
      indicator: (counts.operations?.pendingOrders ?? 0) > 0 ? 'action' : undefined,
    },
    { label: 'Pricing', href: '/pricing', Icon: Tag },
    {
      label: 'Insights',
      href: '/insights',
      Icon: BarChart3,
      children: [
        { label: 'Sales', href: '/insights/sales' },
        { label: 'Profit & Cost', href: '/insights/profit' },
      ],
    },

    // ── Marketing ────────────────────────────────────────────────
    { label: 'Advertising', href: '/marketing/advertising/campaigns', Icon: Megaphone },
    { label: 'Calendar', href: '/marketing/calendar', Icon: CalendarDays },
    { label: 'Content', href: '/marketing/content', Icon: ImageIcon },
    { label: 'Reviews', href: '/marketing/reviews', Icon: Star },

    // ── Monitoring ───────────────────────────────────────────────
    {
      label: 'Inbox',
      href: '/inbox',
      Icon: Inbox,
      badge: n(counts.inbox?.total),
      indicator:
        (counts.inbox?.critical ?? 0) > 0
          ? 'action'
          : (counts.inbox?.warn ?? 0) > 0
            ? 'warning'
            : undefined,
    },
    {
      label: 'Sync Logs',
      href: '/sync-logs',
      Icon: Activity,
      indicator: (counts.monitoring?.syncIssues ?? 0) > 0 ? 'warning' : undefined,
      children: [
        { label: 'Sync Health', href: '/dashboard/health' },
        { label: 'Audit Log', href: '/audit-log' },
        { label: 'Outbound Queue', href: '/outbound' },
        { label: 'Reconciliation', href: '/reconciliation' },
      ],
    },

    // ── System ───────────────────────────────────────────────────
    {
      label: 'Connections',
      href: '/settings/channels',
      Icon: Plug,
      badge: n(counts.system?.connectedChannels),
    },
    { label: 'Mappings', href: '/settings/mappings', Icon: Shuffle },
    { label: 'Settings', href: '/settings', Icon: Settings },
    { label: 'Recycle Bin', href: '/admin/recycle-bin', Icon: Trash2 },
  ]
}
