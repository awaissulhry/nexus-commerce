/**
 * Campaigns column registry — the full Amazon-faithful column catalogue, grouped
 * into the same categories the real "Customise columns" modal uses (Geography,
 * Settings, Delivery, Costs and fees, Reach, Engagement, Conversions, Amazon
 * retail conversions) PLUS a Nexus-only "Profitability" group (true profit /
 * margin / TACOS) that Amazon's console can't show. Pure data: the table owns
 * the cell renderers and sort getters, the modal owns show/hide/reorder.
 */

export type ColCategory =
  | 'Geography'
  | 'Settings'
  | 'Delivery'
  | 'Costs and fees'
  | 'Reach'
  | 'Engagement'
  | 'Conversions'
  | 'Amazon retail conversions'
  | 'Profitability'

export interface ColMeta {
  key: string
  label: string
  category: ColCategory
  numeric?: boolean   // right-aligned metric column
  locked?: boolean    // always shown, pinned first, not removable (Active / Campaign name)
  info?: boolean      // render an (i) affordance in the header
  nexus?: boolean     // Nexus value-add (badged in the picker)
  desc?: string       // one-line description shown in the picker
}

export const COLUMN_META: ColMeta[] = [
  // ── pinned identity (always first, not reorderable / removable) ──────────
  { key: 'active', label: 'Active status', category: 'Settings', locked: true, desc: 'On/off toggle for the campaign.' },
  { key: 'name', label: 'Campaign name', category: 'Settings', locked: true, desc: 'Campaign name and targeting type.' },

  // ── Geography ────────────────────────────────────────────────────────────
  { key: 'country', label: 'Country', category: 'Geography', desc: 'Marketplace the campaign runs in.' },

  // ── Delivery ───────────────────────────────────────────────────────────--
  { key: 'status', label: 'Status', category: 'Delivery', info: true, desc: 'Delivery state — Delivering, Paused, out of budget, etc.' },

  // ── Settings ───────────────────────────────────────────────────────────--
  { key: 'type', label: 'Type', category: 'Settings', info: true, desc: 'Ad product (Sponsored Products / Brands / Display).' },
  { key: 'targeting', label: 'Targeting', category: 'Settings', desc: 'Automatic or manual targeting.' },
  { key: 'portfolio', label: 'Portfolio name', category: 'Settings', info: true, desc: 'Portfolio the campaign belongs to.' },
  { key: 'bidStrategy', label: 'Campaign bidding strategy', category: 'Settings', desc: 'Dynamic bids (down only / up and down) or fixed.' },
  { key: 'startDate', label: 'Start date', category: 'Settings', desc: 'Date the campaign started.' },
  { key: 'endDate', label: 'End date', category: 'Settings', desc: 'Date the campaign ends (if set).' },
  { key: 'budget', label: 'Budget', category: 'Settings', numeric: true, desc: 'Daily budget (inline editable).' },
  { key: 'budgetType', label: 'Budget type', category: 'Settings', desc: 'Daily or lifetime budget.' },

  // ── Costs and fees ─────────────────────────────────────────────────────--
  { key: 'spend', label: 'Spend', category: 'Costs and fees', numeric: true, desc: 'Total ad spend in the period.' },
  { key: 'cpc', label: 'CPC', category: 'Costs and fees', numeric: true, desc: 'Average cost per click.' },
  { key: 'cpm', label: 'CPM', category: 'Costs and fees', numeric: true, desc: 'Cost per 1,000 impressions.' },

  // ── Reach ──────────────────────────────────────────────────────────────--
  { key: 'impressions', label: 'Impressions', category: 'Reach', numeric: true, desc: 'Times your ads were shown.' },
  { key: 'viewableImpr', label: 'Viewable impressions', category: 'Reach', numeric: true, desc: 'Impressions that were viewable (SB/SD).' },

  // ── Engagement ─────────────────────────────────────────────────────────--
  { key: 'clicks', label: 'Clicks', category: 'Engagement', numeric: true, desc: 'Total clicks on your ads.' },
  { key: 'ctr', label: 'Click-through rate', category: 'Engagement', numeric: true, desc: 'Clicks ÷ impressions.' },
  { key: 'dpv', label: 'Detail page views', category: 'Engagement', numeric: true, desc: 'Product detail page views from ads.' },

  // ── Conversions ────────────────────────────────────────────────────────--
  { key: 'orders', label: 'Orders', category: 'Conversions', numeric: true, desc: 'Attributed orders.' },
  { key: 'units', label: 'Units sold', category: 'Conversions', numeric: true, desc: 'Attributed units.' },
  { key: 'cvr', label: 'Conversion rate', category: 'Conversions', numeric: true, desc: 'Orders ÷ clicks.' },
  { key: 'sales', label: 'Sales', category: 'Conversions', numeric: true, desc: 'Attributed sales revenue.' },
  { key: 'acos', label: 'ACOS', category: 'Conversions', numeric: true, desc: 'Spend ÷ sales (lower is better).' },
  { key: 'roas', label: 'ROAS', category: 'Conversions', numeric: true, desc: 'Sales ÷ spend (higher is better).' },
  { key: 'aov', label: 'Avg. order value', category: 'Conversions', numeric: true, desc: 'Sales ÷ orders.' },

  // ── Amazon retail conversions ──────────────────────────────────────────--
  { key: 'ntbOrders', label: 'New-to-brand orders', category: 'Amazon retail conversions', numeric: true, desc: 'Orders from first-time brand buyers.' },
  { key: 'ntbSales', label: 'New-to-brand sales', category: 'Amazon retail conversions', numeric: true, desc: 'Sales from first-time brand buyers.' },
  { key: 'ntbPct', label: '% orders new-to-brand', category: 'Amazon retail conversions', numeric: true, desc: 'Share of orders that were new-to-brand.' },

  // ── Profitability (Nexus value-add — beyond Amazon) ────────────────────--
  { key: 'trueProfit', label: 'True profit', category: 'Profitability', numeric: true, nexus: true, desc: 'Ad sales minus COGS, Amazon fees and ad spend. Amazon can’t show this.' },
  { key: 'marginPct', label: 'Net margin', category: 'Profitability', numeric: true, nexus: true, desc: 'True profit ÷ ad sales.' },
  { key: 'tacos', label: 'TACOS', category: 'Profitability', numeric: true, nexus: true, desc: 'Ad spend ÷ total brand sales.' },
]

export const CATEGORIES: ColCategory[] = [
  'Geography', 'Settings', 'Delivery', 'Costs and fees',
  'Reach', 'Engagement', 'Conversions', 'Amazon retail conversions', 'Profitability',
]

/** Always-on, pinned-left columns (rendered before the manageable set). */
export const LOCKED_KEYS = COLUMN_META.filter((c) => c.locked).map((c) => c.key)

/** The default visible (manageable) columns — totals 18 with the 2 locked. */
export const DEFAULT_VISIBLE = [
  'country', 'status', 'type', 'portfolio', 'startDate', 'endDate', 'budget',
  'impressions', 'clicks', 'ctr', 'spend', 'cpc', 'orders', 'sales', 'acos', 'roas',
]

export const META_BY_KEY: Record<string, ColMeta> = Object.fromEntries(COLUMN_META.map((c) => [c.key, c]))
export const STORAGE_KEY = 'ads-console:campaign-columns:v1'
