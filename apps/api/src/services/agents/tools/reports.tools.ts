/**
 * MCP full control P6 — the Insights hub's reports, read: one tool, `insights-report`, names the report it wants
 * (plan section 09 §4). Each report is the same computation the Insights pages run (services/insights/compute*, the
 * Amazon economics services, the dashboard's Global Snapshot), made compact for a conversation.
 *
 * Money. The pages show their numbers to whoever may open them; Claude's door is stricter (MCP.1): every money key
 * these reports return is stripped, at any depth, for a person without the matching `financials.*` permission —
 * the shared registry's keys (lib/auth/financial-fields.ts) and this tool's own (`restrictedFields`: revenue,
 * refunds, average order value, revenue changes, ad spend and ad sales, stock value). Money written INTO a sentence
 * (what-changed details, anomaly headlines) is moved under a money key first, so it goes with them. The reports that
 * are money from top to bottom — profit, fiscal, Amazon economics, the routes FINANCIAL_ONLY_ROUTE_PREFIXES blocks —
 * are refused outright to a person who may not see all money.
 *
 * Buyers. The customers report needs `customers.view` and shows each top customer by first name and masked e-mail
 * (Owner decision O-1).
 *
 * AI. The executive brief page asks a model to write the brief, which spends Nexus's AI budget; Claude writes its own
 * text (section 09 §1 #16). The `brief` report returns the facts the brief is written from, and calls no model.
 */

import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import { parseInsightsFilters, resolveWindowRange, type InsightsFilters } from '../../insights/index.js'
import { computeInsightsSummary } from '../../insights/insights-summary.service.js'
import { computeInsightsBreakdown } from '../../insights/insights-breakdown.service.js'
import { computeTopSKUs, type TopSKURow } from '../../insights/insights-top-skus.service.js'
import { computeWhatChanged, type WhatChangedFeed } from '../../insights/insights-what-changed.service.js'
import { computeSalesReport } from '../../insights/insights-sales.service.js'
import { computeProfitReport } from '../../insights/insights-profit.service.js'
import { computeAdvertisingReport } from '../../insights/insights-advertising.service.js'
import { computeProductReport } from '../../insights/insights-products.service.js'
import { computeCustomerReport, type CustomerReport } from '../../insights/insights-customers.service.js'
import { computeInventoryReport } from '../../insights/insights-inventory.service.js'
import { computeFiscalReport } from '../../insights/insights-fiscal.service.js'
import { computeForecastReport } from '../../insights/insights-forecast.service.js'
import { computeAnomalies, type AnomalyReport } from '../../insights/insights-anomalies.service.js'
import { getRealAmazonFeeRates, getRealCombinedRateByMarketplace, getRealFbaPerUnitResolver } from '../../amazon-real-fees.service.js'
import { globalSnapshot } from '../../dashboard/global-snapshot.service.js'
import type { AgentTool, FieldPermission, ToolContext } from '../tool-types.js'
import { safeText } from './claude-safe.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
const DAY = 86_400_000

export const REPORTS = [
  'summary', 'sales', 'profit', 'advertising', 'products', 'customers', 'inventory', 'fiscal', 'brief', 'forecast',
  'what-changed', 'top-skus', 'breakdown', 'amazon-economics', 'snapshot',
] as const
type Report = (typeof REPORTS)[number]

const WINDOWS = ['today', '7d', '30d', '90d', 'mtd', 'qtd', 'ytd'] as const
const COMPARES = ['prev', 'wow', 'mom', 'yoy', 'none'] as const
/** The longest window a report reads. */
const MAX_WINDOW_DAYS = 365

/** Money from top to bottom (FINANCIAL_ONLY_ROUTE_PREFIXES): only for a person who may see all money. */
const ALL_MONEY: ReadonlySet<Report> = new Set(['profit', 'fiscal', 'amazon-economics'])
/** The Global Snapshot's periods, by window. */
const SNAPSHOT_PERIODS: Readonly<Record<string, string>> = { today: 'today', '7d': '7d', '30d': '30d', '90d': '90d' }

// ── Money keys this tool returns that the shared registry does not name ────────────────────────────────

const REVENUE = FIELDS.financialsRevenueView
const COSTS = FIELDS.financialsCostsView
const ADSPEND = FIELDS.financialsAdspendView

/**
 * Revenue and everything derived from it — including the percentage changes of revenue (`deltaPct`, the same number
 * in every report that carries one), which would otherwise tell the trend the stripped number hid.
 */
const REPORT_MONEY: Readonly<Record<string, FieldPermission>> = {
  revenue: REVENUE, revenuePrev: REVENUE, refunds: REVENUE, refundsValue: REVENUE, discountValue: REVENUE, aov: REVENUE,
  cumulativeRevenue: REVENUE, revenueNew: REVENUE, revenueReturning: REVENUE, avgLifetimeValue: REVENUE,
  totalSpend: REVENUE, totalSpendCents: REVENUE, totalSpent: REVENUE, minCents: REVENUE, projectedRevenue30: REVENUE,
  stockoutCostEstimate: REVENUE, valueCents: REVENUE, comparePrevValueCents: REVENUE, estimateCents: REVENUE,
  convertedCents: REVENUE, pendingEstimateCents: REVENUE, eurEquivCents: REVENUE, deltaPct: REVENUE,
  deltaRevPct: REVENUE, compareDeltaPct: REVENUE, amounts: REVENUE,
  inventoryValue: COSTS, deadStockValue: COSTS,
  spend: ADSPEND, sales: ADSPEND, cpc: ADSPEND, tacos: ADSPEND, spendNote: ADSPEND,
}

// ── Compact output ─────────────────────────────────────────────────────────────────────────────────────

/** Never handed out: per-day series of a row (bulky), stamps of "now", internal lookups. */
const DROPPED = new Set(['series', 'generatedAt', 'lastUpdatedAt', 'asOf', 'filterEcho', 'map', 'resolve'])
/** Day-by-day lists: the last 31 points. */
const TIME_SERIES = new Set(['trend', 'spark', 'sparkline', 'points'])

/**
 * A report as Claude reads it: lists cut to `limit` (day-by-day series to their last 31 points) with a `<key>More`
 * count of what was left out, texts made safe (e-mails masked, at most 300 characters), Decimals as numbers, nothing
 * that says "now".
 */
function compact(value: unknown, limit: number, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return safeText(value)
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object' || value instanceof Map || value instanceof Set || depth > 8) return undefined
  if (Array.isArray(value)) return value.map((item) => compact(item, limit, depth + 1))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const number = Number(String(value))
    return Number.isFinite(number) ? number : safeText(String(value))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED.has(key) || typeof item === 'function') continue
    if (Array.isArray(item)) {
      const cap = TIME_SERIES.has(key) ? 31 : limit
      const kept = TIME_SERIES.has(key) ? item.slice(-cap) : item.slice(0, cap)
      out[key] = kept.map((entry) => compact(entry, limit, depth + 1))
      if (item.length > cap) out[`${key}More`] = item.length - cap
      continue
    }
    const compacted = compact(item, limit, depth + 1)
    if (compacted !== undefined) out[key] = compacted
  }
  return out
}

// ── Per-report shaping ───────────────────────────────────────────────────────────────────────────────

/** A top-SKU row with its revenue change under a money key. */
const skuRow = (row: TopSKURow) => ({
  sku: row.sku, productName: row.productName, brand: row.brand, revenue: row.revenue, units: row.units, orders: row.orders,
  deltaPct: row.deltaPct,
})

/** What changed, with the amounts the page writes into a sentence moved under a money key. */
const changes = (feed: WhatChangedFeed) => ({
  items: feed.items.map((item) => ({
    id: item.id, severity: item.severity, category: item.category, headline: item.headline,
    ...(item.detail ? { amounts: item.detail } : {}),
  })),
})

/** Anomalies: a revenue or ad-spend headline carries the amount, so it goes under a money key. */
const anomalies = (report: AnomalyReport) => ({
  summary: report.summary,
  items: report.items.map((item) => {
    const key = item.kind === 'AD_SPEND_SPIKE' ? 'spendNote' : item.kind.startsWith('REVENUE') || item.kind === 'CHANNEL_DROP' ? 'amounts' : 'headline'
    return { date: item.date, kind: item.kind, severity: item.severity, zScore: item.zScore, ...(item.context?.channel ? { channel: item.context.channel } : {}), [key]: item.headline }
  }),
})

/** Top customers by first name and masked e-mail (O-1); never their full name. */
const customers = (report: CustomerReport) => ({
  ...report,
  topCustomers: report.topCustomers.map((customer) => ({
    id: customer.id,
    firstName: customer.name?.trim().split(/\s+/)[0] ?? null,
    email: safeText(customer.email),
    totalOrders: customer.totalOrders,
    totalSpent: customer.totalSpent,
    rfmLabel: customer.rfmLabel,
    firstOrderAt: customer.firstOrderAt,
    lastOrderAt: customer.lastOrderAt,
  })),
})

interface Window {
  filters: InsightsFilters
  days: number
}

/** The filters every report reads, or why the window cannot be read. */
function windowOf(args: Record<string, unknown>): Window | { error: string } {
  const from = args.from as string | undefined
  const to = args.to as string | undefined
  const window = from || to ? 'custom' : ((args.window as string | undefined) ?? '30d')
  const filters = parseInsightsFilters({
    query: {
      window,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      compare: (args.compare as string | undefined) ?? 'prev',
      channels: (args.channel as string | undefined) ?? '',
      markets: (args.market as string | undefined) ?? '',
    },
  } as unknown as FastifyRequest)
  const range = resolveWindowRange(filters)
  const span = range.to.getTime() - range.from.getTime()
  if (!(span > 0)) return { error: 'The window ends before it starts: give from earlier than to.' }
  // The end of a custom window is exclusive midnight; one day of slack for the daylight-saving hour.
  if (span > (MAX_WINDOW_DAYS + 1) * DAY) return { error: `A report reads at most ${MAX_WINDOW_DAYS} days: narrow from and to.` }
  return { filters, days: Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.round(span / DAY))) }
}

async function build(report: Report, { filters, days }: Window, args: Record<string, unknown>, limit: number): Promise<unknown> {
  switch (report) {
    case 'summary': {
      const [summary, top] = await Promise.all([computeInsightsSummary(filters), computeTopSKUs(filters, 5)])
      return { ...summary, topSkus: top.map(skuRow) }
    }
    case 'sales':
      return computeSalesReport(filters)
    case 'profit':
      return computeProfitReport(filters)
    case 'advertising':
      return computeAdvertisingReport(filters)
    case 'products':
      return computeProductReport(filters)
    case 'customers':
      return customers(await computeCustomerReport(filters))
    case 'inventory':
      return computeInventoryReport(filters)
    case 'fiscal':
      return computeFiscalReport(filters)
    case 'brief': {
      const [summary, breakdown, whatChanged, found, advertising] = await Promise.all([
        computeInsightsSummary(filters),
        computeInsightsBreakdown(filters),
        computeWhatChanged(filters),
        computeAnomalies(filters),
        computeAdvertisingReport(filters),
      ])
      return {
        note: 'The facts the executive brief is written from. Write the brief yourself; Nexus calls no AI model here.',
        summary,
        breakdown,
        whatChanged: changes(whatChanged),
        anomalies: anomalies(found),
        advertising: { currency: advertising.currency, totals: advertising.totals, deltas: advertising.deltas },
      }
    }
    case 'forecast':
      return computeForecastReport(filters)
    case 'what-changed':
      return changes(await computeWhatChanged(filters))
    case 'top-skus':
      return { rows: (await computeTopSKUs(filters, limit)).map(skuRow) }
    case 'breakdown':
      return computeInsightsBreakdown(filters)
    case 'amazon-economics': {
      const [fees, combined, fba] = await Promise.all([
        getRealAmazonFeeRates(days),
        getRealCombinedRateByMarketplace(days),
        getRealFbaPerUnitResolver(days),
      ])
      return {
        periodDays: days,
        feeRates: fees,
        combinedRate: { blendedPct: combined.blendedPct, byMarketplace: combined.byMarketplace },
        fbaPerUnit: {
          overallPerUnitEur: fba.overallPerUnitCents != null ? fba.overallPerUnitCents / 100 : null,
          byMarketplace: fba.byMarketplace.map((m) => ({ marketplace: m.marketplace, perUnitEur: m.perUnitCents != null ? m.perUnitCents / 100 : null, units: m.units })),
        },
      }
    }
    case 'snapshot': {
      const snapshot = await globalSnapshot({ period: SNAPSHOT_PERIODS[String(args.window ?? 'today')], marketplace: args.market as string | undefined })
      // The sales block is renamed apart from its parts (`sales` is an ad-sales money key here); the period's end
      // is "now", which is never echoed.
      return {
        period: { key: snapshot.period.key, from: snapshot.period.from, timezone: snapshot.period.timezone },
        marketplace: snapshot.marketplace,
        availableMarketplaces: snapshot.availableMarketplaces,
        total: snapshot.sales.total,
        sparkline: snapshot.sales.sparkline,
        byMarketplace: snapshot.sales.byMarketplace,
        openOrders: snapshot.openOrders,
      }
    }
  }
}

/** Why this person may not read this report, or null. */
function refusalFor(report: Report, ctx: ToolContext): string | null {
  if (ALL_MONEY.has(report) && !ctx.can(FIELDS.financialsView)) {
    return `The ${report} report is money from top to bottom: it needs permission to see all money (financials.view). Ask an owner, or read it in Nexus.`
  }
  if (report === 'customers' && !ctx.can(F.customersView)) return 'The customers report needs permission to see customers (customers.view).'
  return null
}

const insightsReport: AgentTool = {
  name: 'insights-report',
  title: 'Insights report',
  category: 'insights',
  description:
    'One report from the Insights hub, for a window (default the last 30 days, compared with the 30 before; at most '
    + '365 days), optionally for one channel or market: summary (headline numbers and the 5 best-selling SKUs), '
    + 'sales, profit, advertising, products, customers, inventory, fiscal (VAT), brief (the facts an executive brief '
    + 'is written from), forecast, what-changed, top-skus, breakdown (by channel and market), amazon-economics (real '
    + 'Amazon fee rates), snapshot (the dashboard\'s Global Snapshot: today, 7d, 30d or 90d). Money is shown only to '
    + 'a person who may see it; profit, fiscal and amazon-economics need permission to see all money. Lists are cut '
    + 'to limit (default 10). Read only.',
  input: z.object({
    report: z.enum(REPORTS).describe('which report'),
    window: z.enum(WINDOWS).optional()
      .describe('the period: today, 7d, 30d (default), 90d, mtd, qtd or ytd (month, quarter, year to date)'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('a window of your own instead: first day, YYYY-MM-DD (Europe/Rome); at most 365 days with to'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('with from: the day after the last day, YYYY-MM-DD'),
    compare: z.enum(COMPARES).optional()
      .describe('compare with: prev (the period before, default), wow, mom, yoy (same period a week, month, year earlier) or none'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only this channel'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code, e.g. IT or DE'),
    limit: z.coerce.number().int().min(1).max(20).optional().describe('rows per list (default 10, at most 20)'),
  }),
  requires: [F.insightsView],
  restrictedFields: REPORT_MONEY,
  riskTier: 'low',
  readOnly: true,
  async handler(args, ctx) {
    const report = args.report as Report
    const refused = refusalFor(report, ctx)
    if (refused) return { ok: false, error: refused }
    if (report === 'snapshot' && !SNAPSHOT_PERIODS[String(args.window ?? 'today')]) {
      return { ok: false, error: 'The snapshot reads today, 7d, 30d or 90d: set window to one of them.' }
    }
    if (report === 'snapshot' && (args.from || args.to)) return { ok: false, error: 'The snapshot reads today, 7d, 30d or 90d, not from and to.' }
    const window = windowOf(args)
    if ('error' in window) return { ok: false, error: window.error }
    const limit = (args.limit as number | undefined) ?? 10
    const result = await build(report, window, args, limit)
    return { ok: true, data: { report, ...(compact(result, limit) as Record<string, unknown>) } }
  },
}

export const REPORT_TOOLS: AgentTool[] = [insightsReport]
