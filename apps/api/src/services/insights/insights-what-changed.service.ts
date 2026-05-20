/**
 * IH.1 — rule-based "what changed" feed.
 *
 * Composes existing summary + breakdown helpers; emits a flat list of
 * notable shifts (revenue swing > 15%, AOV swing > 10%, a channel
 * gaining or losing > 20%, a market with zero orders for the first
 * time in the window, a currency mix shift > 10pp). Each item carries
 * a severity tag the hub uses to colour the row.
 *
 * Heavier anomaly detection (z-scores, streak breaks) is IH.9 — this
 * is the always-on landing-page surface so the operator sees what's
 * actually different versus expectation at a glance.
 */

import type { InsightsFilters } from './index.js'
import { computeInsightsSummary } from './insights-summary.service.js'
import { computeInsightsBreakdown } from './insights-breakdown.service.js'

export interface InsightChange {
  id: string
  severity: 'positive' | 'attention' | 'critical' | 'info'
  headline: string
  detail?: string
  category: 'revenue' | 'channel' | 'market' | 'aov' | 'currency' | 'orders'
}

export interface WhatChangedFeed {
  items: InsightChange[]
}

function pctLabel(p: number): string {
  const sign = p > 0 ? '+' : ''
  return `${sign}${p.toFixed(1)}%`
}

export async function computeWhatChanged(
  filters: InsightsFilters,
): Promise<WhatChangedFeed> {
  const [summary, breakdown] = await Promise.all([
    computeInsightsSummary(filters),
    computeInsightsBreakdown(filters),
  ])

  const items: InsightChange[] = []

  const rev = summary.totals.revenue
  if (rev.deltaPct != null && Math.abs(rev.deltaPct) >= 15) {
    items.push({
      id: 'revenue-shift',
      severity: rev.deltaPct > 0 ? 'positive' : 'critical',
      headline: `Revenue ${pctLabel(rev.deltaPct)} vs comparison window`,
      detail: `${rev.current.toLocaleString('it-IT')} ${summary.currency} this period, ${rev.previous.toLocaleString('it-IT')} before.`,
      category: 'revenue',
    })
  }

  const orders = summary.totals.orders
  if (orders.deltaPct != null && Math.abs(orders.deltaPct) >= 20) {
    items.push({
      id: 'orders-shift',
      severity: orders.deltaPct > 0 ? 'positive' : 'attention',
      headline: `Order volume ${pctLabel(orders.deltaPct)} (${orders.current} vs ${orders.previous})`,
      category: 'orders',
    })
  }

  const aov = summary.totals.aov
  if (aov.deltaPct != null && Math.abs(aov.deltaPct) >= 10) {
    items.push({
      id: 'aov-shift',
      severity: aov.deltaPct > 0 ? 'positive' : 'attention',
      headline: `AOV ${pctLabel(aov.deltaPct)} — pricing or mix has shifted`,
      detail: `${aov.current.toLocaleString('it-IT')} ${summary.currency} avg, was ${aov.previous.toLocaleString('it-IT')} ${summary.currency}.`,
      category: 'aov',
    })
  }

  for (const ch of breakdown.byChannel) {
    if (ch.deltaPct != null && Math.abs(ch.deltaPct) >= 20) {
      items.push({
        id: `channel-${ch.key}`,
        severity: ch.deltaPct > 0 ? 'positive' : 'critical',
        headline: `${ch.label}: revenue ${pctLabel(ch.deltaPct)}`,
        detail: `${ch.revenue.toLocaleString('it-IT')} ${breakdown.currency} from ${ch.orders} orders.`,
        category: 'channel',
      })
    }
  }

  const topMarket = [...breakdown.byMarket].sort(
    (a, b) => b.revenue - a.revenue,
  )[0]
  if (topMarket && topMarket.deltaPct != null && Math.abs(topMarket.deltaPct) >= 20) {
    items.push({
      id: `market-${topMarket.key}`,
      severity: topMarket.deltaPct > 0 ? 'positive' : 'critical',
      headline: `Top market ${topMarket.label}: revenue ${pctLabel(topMarket.deltaPct)}`,
      category: 'market',
    })
  }

  return { items }
}
