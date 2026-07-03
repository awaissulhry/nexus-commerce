/**
 * CBN — the new (Adtomic / "Helium 10 Ads"-matched) ads console, built in isolation at
 * /marketing/ads so the current /marketing/ads-console keeps working; we transfer later.
 * Nav extracted exactly from the H10 source (label · route · FontAwesome icon → lucide).
 * Glyphs matched item-for-item off the real H10 rail recording. Two are version-limited
 * by lucide-react 0.263.1: Ad Manager (H10's 2x2 windowpane = Grid2x2, not in 0.263 → Table)
 * and Rules (H10's wand-with-stars = WandSparkles, not in 0.263 → Wand2, near-identical).
 */
import {
  LayoutGrid, Gauge, BadgeDollarSign, Atom, Sparkles, ListChecks, Lightbulb, HeartPulse, BarChart3, Table, Briefcase, Wand2, Users, PieChart, History, HelpCircle, Settings, ShoppingBag,
  type LucideIcon,
} from 'lucide-react'

export const ADS_BASE = '/marketing/ads'

export interface NavItem {
  label: string
  route: string
  Icon: LucideIcon
  children?: { label: string; route: string }[]
  /** When set, the item is an external link (new tab) with a trailing external-link glyph. */
  external?: string
}

/**
 * E4.1 — ONE console, channel-switched (user decision 2026-07-03): the rail
 * carries an [Amazon | eBay] switch in the brand area instead of a separate
 * eBay nav group. In eBay mode the SAME rail renders this list (same look,
 * separate pages → zero interference with the in-flight Amazon grid).
 * Page-level merging (channel dropdown inside one grid) is the later
 * convergence path once the Amazon console stabilizes.
 */
export const EBAY_ADS_NAV: NavItem[] = [
  { label: 'Dashboard', route: 'ebay', Icon: Gauge },
  { label: 'Ad Manager', route: 'ebay/campaigns', Icon: Table },
  { label: 'Products', route: 'ebay/products', Icon: ShoppingBag },
  { label: 'Rules & Automation', route: 'ebay/automation', Icon: Wand2 }, // ER1 (D3) — parity with the Amazon rail
  { label: 'Change Log', route: 'ebay/change-log', Icon: History }, // ER3.4 (D4) — account-wide audit trail
  { label: 'Weekly Digest', route: 'ebay/digest', Icon: PieChart },
]

export const ADS_NAV: NavItem[] = [
  { label: 'Account Overview', route: 'account-overview', Icon: LayoutGrid },
  { label: 'Dashboard', route: 'dashboard', Icon: Gauge },
  { label: 'Budget Manager', route: 'budget-manager', Icon: BadgeDollarSign },
  { label: 'AI Advertising', route: 'ai-advertising', Icon: Atom },
  { label: 'AI Control', route: 'autopilot', Icon: Sparkles },
  { label: 'Suggestions', route: 'suggestions', Icon: ListChecks },
  { label: 'Recommendations', route: 'recommendations', Icon: Lightbulb },
  { label: 'Alerts & Health', route: 'health', Icon: HeartPulse },
  { label: 'Analytics', route: 'analytics', Icon: BarChart3 },
  { label: 'Ad Manager', route: 'campaigns', Icon: Table },
  { label: 'Portfolios', route: 'portfolios', Icon: Briefcase },
  { label: 'Rules & Automation', route: 'rules-automation', Icon: Wand2 },
  { label: 'AMC', route: 'amc', Icon: Users, children: [{ label: 'AMC Insights', route: 'amc' }, { label: 'Audience Insights', route: 'amc/audiences' }] },
  { label: 'Reporting', route: 'reporting', Icon: PieChart, children: [{ label: 'Brand Metrics', route: 'reporting/brand-metrics' }] },
  { label: 'Change Log', route: 'changelog', Icon: History },
  { label: 'Training & Resources', route: 'training', Icon: HelpCircle, external: 'https://advertising.amazon.com' },
  { label: 'Settings', route: 'account-settings', Icon: Settings },
]
