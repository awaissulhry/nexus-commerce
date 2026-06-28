/**
 * Products-next rail nav — full app navigation mirrored as RailNavItem[].
 *
 * Faithfully replicates AppSidebar's sections (Catalog / Syndication /
 * Fulfillment / Marketing / Operations / Monitoring / System) with the same
 * lucide icons and absolute hrefs. Count badges are omitted here (no live data
 * in a static export); wire them in via AppRail's `badge` prop if needed later.
 *
 * "Products [active here]" is the first Catalog item; the rail will auto-apply
 * the `.on` active state via pathname comparison in AppRail.
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
import type { RailNavItem } from '@/app/_shared/AppRail'

export const PRODUCTS_NAV: RailNavItem[] = [
  // ── Home ──────────────────────────────────────────────────────
  { label: 'Home', href: '/', Icon: Home },

  // ── Catalog ───────────────────────────────────────────────────
  {
    label: 'Products',
    href: '/products',
    Icon: Package,
    children: [
      { label: 'Matrix',          href: '/catalog/matrix' },
      { label: 'Drafts',          href: '/products/drafts' },
      { label: 'Organize',        href: '/catalog/organize' },
      { label: 'Bulk Operations', href: '/bulk-operations' },
    ],
  },

  // ── Syndication ───────────────────────────────────────────────
  {
    label: 'Listings',
    href: '/listings',
    Icon: Boxes,
    children: [
      { label: 'Amazon',  href: '/listings/amazon' },
      { label: 'eBay',    href: '/listings/ebay' },
      { label: 'Shopify', href: '/listings/shopify' },
    ],
  },

  // ── Fulfillment ───────────────────────────────────────────────
  { label: 'Stock',           href: '/fulfillment/stock',           Icon: Warehouse },
  { label: 'Inbound',         href: '/fulfillment/inbound',         Icon: PackageCheck },
  { label: 'Outbound',        href: '/fulfillment/outbound',        Icon: PackageOpen },
  { label: 'Replenishment',   href: '/fulfillment/replenishment',   Icon: RefreshCw },
  { label: 'Purchase Orders', href: '/fulfillment/purchase-orders', Icon: ShoppingCart },
  { label: 'Suppliers',       href: '/fulfillment/suppliers',       Icon: Factory },
  { label: 'Carriers',        href: '/fulfillment/carriers',        Icon: Truck },
  { label: 'Returns',         href: '/fulfillment/returns',         Icon: Undo2 },

  // ── Operations ────────────────────────────────────────────────
  { label: 'Orders',  href: '/orders',  Icon: FileText },
  { label: 'Pricing', href: '/pricing', Icon: Tag },
  {
    label: 'Insights',
    href: '/insights',
    Icon: BarChart3,
    children: [
      { label: 'Sales',        href: '/insights/sales' },
      { label: 'Profit & Cost', href: '/insights/profit' },
    ],
  },

  // ── Marketing ─────────────────────────────────────────────────
  { label: 'Advertising', href: '/marketing/advertising/campaigns', Icon: Megaphone },
  { label: 'Calendar',    href: '/marketing/calendar',              Icon: CalendarDays },
  { label: 'Content',     href: '/marketing/content',               Icon: ImageIcon },
  { label: 'Reviews',     href: '/marketing/reviews',               Icon: Star },

  // ── Monitoring ────────────────────────────────────────────────
  { label: 'Inbox',     href: '/inbox',     Icon: Inbox },
  {
    label: 'Sync Logs',
    href: '/sync-logs',
    Icon: Activity,
    children: [
      { label: 'Sync Health',    href: '/dashboard/health' },
      { label: 'Audit Log',      href: '/audit-log' },
      { label: 'Outbound Queue', href: '/outbound' },
      { label: 'Reconciliation', href: '/reconciliation' },
    ],
  },

  // ── System ────────────────────────────────────────────────────
  { label: 'Connections', href: '/settings/channels',  Icon: Plug },
  { label: 'Mappings',    href: '/settings/mappings',  Icon: Shuffle },
  { label: 'Settings',    href: '/settings',            Icon: Settings },
  { label: 'Recycle Bin', href: '/admin/recycle-bin',   Icon: Trash2 },
]
