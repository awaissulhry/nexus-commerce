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
  Bot,
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

/** Full country-name lookup (used inline + by the "See all markets" modal). */
export const COUNTRY_NAMES: Record<string, string> = {
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
}

/** Full set of marketplaces each channel supports (the modal's long tail). */
export const SUPPORTED_MARKETS: Record<string, string[]> = {
  AMAZON: ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'SE', 'PL', 'BE', 'TR', 'US', 'CA', 'MX', 'BR', 'AE', 'SA', 'JP', 'AU'],
  EBAY: ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'AT', 'CH', 'IE', 'PL', 'US', 'CA', 'AU', 'HK', 'SG', 'MY'],
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
          moreMarketsCount: SUPPORTED_MARKETS.AMAZON.length,
        },
        {
          label: 'eBay',
          href: '/listings/ebay',
          indicator: conn.ebay ? undefined : 'disconnected',
          children: markets('ebay'),
          moreMarketsCount: SUPPORTED_MARKETS.EBAY.length,
        },
        { label: 'Shopify', href: '/listings/shopify' },
      ],
    },

    // ── Fulfillment ──────────────────────────────────────────────
    {
      label: 'Stock',
      href: '/fulfillment/stock',
      Icon: Warehouse,
      children: [
        { label: 'Control Tower', href: '/fulfillment/stock/control-tower' },
        { label: 'Channel Drift', href: '/fulfillment/stock/channel-drift' },
      ],
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
    // H1.1 added a second child, "Advertising (classic)", because the legacy tree still held ~25
    // areas with no equivalent — repointing without it would have stranded working pages.
    //
    // ACR.6 (Stage 6) removes it. Every one of those areas now either has an equivalent in the
    // console, was ported into one (P&L, budget pools, iROAS, the account plan, execution rollback,
    // fleet impact, operator notes, the endpoint probe), or was deleted because prod proved it had
    // never been used. What remains of /marketing/advertising is two parked interpretation pages
    // that belong to Analytics; they are reachable by link and do not want a rail entry of their own.
    //
    // One console, one entry. A menu that offers "classic" alongside "current" is a menu that
    // teaches operators the current one is optional.
    {
      label: 'Advertising',
      href: '/marketing/ads',
      Icon: Megaphone,
      children: [
        { label: 'Ads Console', href: '/marketing/ads' },
        { label: 'Reporting', href: '/marketing/ads/reporting' },
      ],
    },
    { label: 'Calendar', href: '/marketing/calendar', Icon: CalendarDays },
    { label: 'Content', href: '/marketing/content', Icon: ImageIcon },
    { label: 'Reviews', href: '/marketing/reviews', Icon: Star },

    // ── Agents ───────────────────────────────────────────────────
    // NAF.SB.7 — the Agent Fleet sits on the APP rail, not inside the ads
    // console (operator call 2026-08-07). It governs LLM agents over the
    // deterministic engines, and the roster in docs/AGENT_FLEET.md Part 6
    // already reaches catalog, pricing, inventory and platform-ops analysts —
    // only the first cohort happens to be ads. Filing it under Advertising
    // would have made a cross-domain governance layer look like a marketing
    // feature. The ads rail keeps one cross-link, never the ten children.
    //
    // The three sub-rows are GROUPS, not pages: Operate is what is happening,
    // Build is what should happen, Govern is what may happen. AppRail's
    // second level must be navigable, so each group carries its own first
    // page as its href — clicking "Build" lands on Workers, which is where
    // that group starts anyway.
    {
      label: 'Agent Fleet',
      href: '/fleet',
      Icon: Bot,
      children: [
        {
          label: 'Operate',
          href: '/fleet',
          children: [
            { label: 'Overview', href: '/fleet' },
            { label: 'Approvals', href: '/fleet/approvals' },
            { label: 'Activity', href: '/fleet/activity' },
            { label: 'Fleet map', href: '/fleet/map' },
          ],
        },
        {
          label: 'Build',
          href: '/fleet/workers',
          children: [
            { label: 'Workers', href: '/fleet/workers' },
            { label: 'Workflows', href: '/fleet/workflows' },
            { label: 'Assignments', href: '/fleet/assignments' },
            { label: 'Files & data', href: '/fleet/files' },
          ],
        },
        {
          label: 'Govern',
          href: '/fleet/cost',
          children: [
            { label: 'Cost & value', href: '/fleet/cost' },
            { label: 'Controls', href: '/fleet/controls' },
          ],
        },
      ],
    },

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
