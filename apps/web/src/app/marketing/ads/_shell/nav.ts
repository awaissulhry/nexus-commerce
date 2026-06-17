/**
 * CBN — the new (Adtomic / "Helium 10 Ads"-matched) ads console, built in isolation at
 * /marketing/ads so the current /marketing/ads-console keeps working; we transfer later.
 * Nav extracted exactly from the H10 source (label · route · FontAwesome icon → lucide).
 */
import {
  LayoutGrid, Gauge, Coins, Sparkles, ListChecks, BarChart3, Table, Wand2, Database, PieChart, History, Settings,
  type LucideIcon,
} from 'lucide-react'

export const ADS_BASE = '/marketing/ads'

export interface NavItem { label: string; route: string; Icon: LucideIcon; children?: { label: string; route: string }[] }

export const ADS_NAV: NavItem[] = [
  { label: 'Account Overview', route: 'account-overview', Icon: LayoutGrid },
  { label: 'Dashboard', route: 'dashboard', Icon: Gauge },
  { label: 'Budget Manager', route: 'budget-manager', Icon: Coins },
  { label: 'AI Advertising', route: 'ai-advertising', Icon: Sparkles },
  { label: 'Suggestions', route: 'suggestions', Icon: ListChecks },
  { label: 'Analytics', route: 'analytics', Icon: BarChart3 },
  { label: 'Ad Manager', route: 'campaigns', Icon: Table },
  { label: 'Rules & Automation', route: 'rules-automation', Icon: Wand2 },
  { label: 'AMC', route: 'amc', Icon: Database, children: [{ label: 'AMC Insights', route: 'amc' }, { label: 'Audience Insights', route: 'amc/audiences' }] },
  { label: 'Reporting', route: 'reporting', Icon: PieChart, children: [{ label: 'Brand Metrics', route: 'reporting/brand-metrics' }] },
  { label: 'Change Log', route: 'changelog', Icon: History },
  { label: 'Settings', route: 'account-settings', Icon: Settings },
]
