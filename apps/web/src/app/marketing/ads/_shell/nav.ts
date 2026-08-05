/**
 * CBN — the new (Adtomic / "Helium 10 Ads"-matched) ads console, built in isolation at
 * /marketing/ads so the current /marketing/ads-console keeps working; we transfer later.
 * Nav extracted exactly from the H10 source (label · route · FontAwesome icon → lucide).
 * Glyphs matched item-for-item off the real H10 rail recording. Two are version-limited
 * by lucide-react 0.263.1: Ad Manager (H10's 2x2 windowpane = Grid2x2, not in 0.263 → Table)
 * and Rules (H10's wand-with-stars = WandSparkles, not in 0.263 → Wand2, near-identical).
 */
import {
  LayoutGrid, Gauge, BadgeDollarSign, FileSpreadsheet, Atom, ListChecks, Lightbulb, HeartPulse, BarChart3, Table, Briefcase, Wand2, Users, PieChart, History, HelpCircle, Settings, ShoppingBag, ShieldCheck,
  type LucideIcon } from 'lucide-react'

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
  { label: 'Suggestions', route: 'suggestions', Icon: ListChecks },
  { label: 'Recommendations', route: 'recommendations', Icon: Lightbulb },
  { label: 'Alerts & Health', route: 'health', Icon: HeartPulse },
  // AX-VT.6 — "does Nexus match Amazon right now". Sits beside Alerts & Health because it answers
  // the neighbouring question: Health is about our own machinery, Trust is about whether the
  // account actually looks the way this console claims it does.
  { label: 'Trust', route: 'trust', Icon: ShieldCheck },
  { label: 'Analytics', route: 'analytics', Icon: BarChart3 },
  { label: 'Ad Manager', route: 'campaigns', Icon: Table },
  { label: 'Portfolios', route: 'portfolios', Icon: Briefcase },
  // AX3.5 — "Blueprints" used to live here. Replication is a way of CREATING
  // campaigns, so it moved to the Campaign Builder alongside the other five
  // builder types, as "Replicate Structure". /marketing/ads/blueprints redirects
  // there. Nothing was removed — the blueprint library is reachable from inside
  // the builder, and saving one is an action at the end of a run.
  // AX-IE.8 — the bulksheet round trip: download current state, edit in Excel or
  // Numbers, upload, preview what it would do, apply, undo.
  { label: 'Bulk Operations', route: 'bulk', Icon: FileSpreadsheet },
  // ACR.1 — the Control Room hangs off Rules & Automation as a chevron child (operator
  // decision 2026-08-05), the same shape AMC and Reporting already use.
  //
  // NOT an 11th tab in the rules tab bar: those tabs are each one rule TYPE, while the
  // Control Room governs every engine — rank/dayparting, budget enforcement, pools, harvest,
  // the anomaly breaker — most of which are not rules at all. Filing it as a rule type would
  // repeat the category error that made the old autonomy board feel smaller than the machine.
  //
  // ACR.1.6 — "AI Control" (route: autopilot) is RETIRED from the rail. Its autonomy board is
  // now this room's Rules section — same endpoint, same dial, same graduation ceilings, beside
  // the engines the board never listed — and keeping two surfaces that edit the same rules is
  // how they drift. The condition set when the Control Room shipped ("used in anger, UI pass
  // done") is met: it has been read on prod and three layout defects found there are fixed.
  //
  // Mission Control was NOT superseded; it is a view of the account's shape. It keeps
  // /marketing/ads/autopilot and is reached from the Control Room's Today tab, because it is a
  // map rather than a control surface. Net rail count is down one, never up.
  { label: 'Rules & Automation', route: 'rules-automation', Icon: Wand2, children: [{ label: 'Control Room', route: 'rules-automation/control-room' }] },
  { label: 'AMC', route: 'amc', Icon: Users, children: [{ label: 'AMC Insights', route: 'amc' }, { label: 'Audience Insights', route: 'amc/audiences' }] },
  { label: 'Reporting', route: 'reporting', Icon: PieChart, children: [{ label: 'Brand Metrics', route: 'reporting/brand-metrics' }] },
  // The Amazon Change Log is reached from the header of the pages that produce changes, not from
  // here — the rail is kept short on purpose, and 99% of recorded changes come from one page.
  // The eBay rail keeps its own entry: that console has no equivalent header link.
  { label: 'Training & Resources', route: 'training', Icon: HelpCircle, external: 'https://advertising.amazon.com' },
  { label: 'Settings', route: 'account-settings', Icon: Settings },
]
