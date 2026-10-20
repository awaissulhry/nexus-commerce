/**
 * CBN — the new (Adtomic / "Helium 10 Ads"-matched) ads console, built in isolation at
 * /marketing/ads so the current /marketing/ads-console keeps working; we transfer later.
 * Nav extracted exactly from the H10 source (label · route · FontAwesome icon → lucide).
 * Glyphs matched item-for-item off the real H10 rail recording. Two are version-limited
 * by lucide-react 0.263.1: Ad Manager (H10's 2x2 windowpane = Grid2x2, not in 0.263 → Table)
 * and Rules (H10's wand-with-stars = WandSparkles, not in 0.263 → Wand2, near-identical).
 */
import {
  LayoutGrid, Gauge, BadgeDollarSign, FileSpreadsheet, Atom, ListChecks, HeartPulse, BarChart3, Table, Briefcase, Wand2, Users, PieChart, History, HelpCircle, Settings, ShoppingBag, ShieldCheck, Bot,
  type LucideIcon } from 'lucide-react'

export const ADS_BASE = '/marketing/ads'

export interface NavChild {
  label: string
  route: string
}

export interface NavItem {
  label: string
  route: string
  Icon: LucideIcon
  children?: NavChild[]
  /** NAF.SB.7 — an absolute in-app path, for a row that leaves this console
   *  entirely (the Agent Fleet lives at /fleet, on the app-wide rail). When
   *  set, `route` is used only as a React key and for active-state, never to
   *  build the URL. */
  href?: string
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

/**
 * Google Ads step 1a — the third channel on the same switch (PLAN.md L8, the eBay precedent). Google is READ ONLY in
 * Nexus for now, so its rail is short: one Ad Manager page and the place its accounts are chosen (Settings › Channels ›
 * Google, which leaves this console like the Amazon rail's Settings row).
 */
export const GOOGLE_ADS_NAV: NavItem[] = [
  { label: 'Ad Manager', route: 'google', Icon: Table },
  { label: 'Settings', route: 'google-settings', href: '/settings/channels/google', Icon: Settings },
]

/**
 * Meta ads step 2 — the fourth channel on the same switch, read only like Google's start: one Ad Manager page and the
 * place its connection and ad account are set (Settings › Channels › Meta, which leaves this console).
 */
export const META_ADS_NAV: NavItem[] = [
  { label: 'Ad Manager', route: 'meta', Icon: Table },
  { label: 'Settings', route: 'meta-settings', href: '/settings/channels/meta', Icon: Settings },
]

export type AdChannel = 'amazon' | 'ebay' | 'google' | 'meta'

const under = (pathname: string, route: string) => pathname === `${ADS_BASE}/${route}` || pathname.startsWith(`${ADS_BASE}/${route}/`)

/** Which channel's console a path is in. */
export function adChannelOf(pathname: string): AdChannel {
  if (under(pathname, 'ebay')) return 'ebay'
  if (under(pathname, 'google')) return 'google'
  if (under(pathname, 'meta')) return 'meta'
  return 'amazon'
}

/** The rail for a channel. */
export function navFor(channel: AdChannel): NavItem[] {
  return channel === 'ebay' ? EBAY_ADS_NAV : channel === 'google' ? GOOGLE_ADS_NAV : channel === 'meta' ? META_ADS_NAV : ADS_NAV
}

// E4.1 — channel counterparts: switching keeps you on the equivalent page.
const TO_EBAY: Record<string, string> = {
  campaigns: 'ebay/campaigns',
  dashboard: 'ebay',
  changelog: 'ebay/change-log',
}
const TO_AMAZON: Record<string, string> = {
  'ebay/campaigns': 'campaigns',
  'ebay/products': 'campaigns',
  'ebay/change-log': 'changelog',
  ebay: 'dashboard',
}

/**
 * Where the channel switch goes (a route under ADS_BASE), or null when you are already there. Google and Meta have one
 * page each, so every page switches to it; from either you land on the other channel's Ad Manager, its counterpart.
 */
export function switchTarget(pathname: string, to: AdChannel): string | null {
  const from = adChannelOf(pathname)
  if (from === to) return null
  if (to === 'google') return 'google'
  if (to === 'meta') return 'meta'
  if (from === 'google' || from === 'meta') return to === 'ebay' ? 'ebay/campaigns' : 'campaigns'
  const current = pathname.slice(ADS_BASE.length + 1) // strip "/marketing/ads/"
  const map = to === 'ebay' ? TO_EBAY : TO_AMAZON
  const hit = Object.entries(map).find(([route]) => current === route || current.startsWith(`${route}/`))
  return hit ? hit[1] : to === 'ebay' ? 'ebay' : 'dashboard'
}

export const ADS_NAV: NavItem[] = [
  { label: 'Account Overview', route: 'account-overview', Icon: LayoutGrid },
  { label: 'Dashboard', route: 'dashboard', Icon: Gauge },
  { label: 'Budget Manager', route: 'budget-manager', Icon: BadgeDollarSign },
  { label: 'AI Advertising', route: 'ai-advertising', Icon: Atom },
  { label: 'Suggestions', route: 'suggestions', Icon: ListChecks },
  // SG.4 — Recommendations is the Suggestions page's 7th tab; the route redirects there.
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
  // NAF.SB.7 — the Agent Fleet LEFT this console (operator call 2026-08-07). It is
  // not a marketing surface: the roster in docs/AGENT_FLEET.md Part 6 already reaches
  // catalog, pricing, inventory and platform-ops analysts, and only its first cohort
  // happens to be ads. It now lives at /fleet on the app-wide rail, with its ten pages
  // grouped Operate · Build · Govern there (app/_shared/app-nav.ts).
  //
  // ONE cross-link stays, because ads operators are the people using it today.
  // Following it leaves this console and the chrome changes — which is honest, you
  // have gone somewhere else. Never the ten children: two navigation trees over the
  // same pages would drift.
  { label: 'Agent Fleet', route: 'fleet', href: '/fleet', Icon: Bot },
  { label: 'Rules & Automation', route: 'rules-automation', Icon: Wand2, children: [{ label: 'Control Room', route: 'rules-automation/control-room' }] },
  { label: 'AMC', route: 'amc', Icon: Users, children: [{ label: 'AMC Insights', route: 'amc' }, { label: 'Audience Insights', route: 'amc/audiences' }] },
  { label: 'Reporting', route: 'reporting', Icon: PieChart, children: [{ label: 'Brand Metrics', route: 'reporting/brand-metrics' }] },
  // The Amazon Change Log is reached from the header of the pages that produce changes, not from
  // here — the rail is kept short on purpose, and 99% of recorded changes come from one page.
  // The eBay rail keeps its own entry: that console has no equivalent header link.
  { label: 'Training & Resources', route: 'training', Icon: HelpCircle, external: 'https://advertising.amazon.com' },
  // AM-29 — the advertising settings (connections, read/write state) live at /settings/advertising; this row opened a
  // "not built yet" stub. Following it leaves the console, like the Agent Fleet row. The old route redirects there.
  { label: 'Settings', route: 'account-settings', href: '/settings/advertising', Icon: Settings },
]
