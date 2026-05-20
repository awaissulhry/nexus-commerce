/**
 * IH.9 — z-score anomaly detection.
 *
 * Pulls daily series for revenue, order count, return count, ad
 * spend, and per-channel revenue across a 90-day reference window
 * (regardless of the operator's chosen window), computes mean + std,
 * and flags any day in the on-screen window whose value sits more
 * than 2 std from the trailing mean. Each anomaly carries severity
 * (info/attention/critical) based on the absolute z-score.
 *
 * Where IH.1's WhatChanged feed is "did the totals move", IH.9 is
 * "did a single day spike or drop unexpectedly". The two work
 * together: WhatChanged surfaces the rollup, Anomalies surfaces the
 * specific event driving the rollup.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
} from './index.js'

export type AnomalySeverity = 'info' | 'attention' | 'critical'
export type AnomalyKind =
  | 'REVENUE_SPIKE'
  | 'REVENUE_DROP'
  | 'ORDERS_SPIKE'
  | 'ORDERS_DROP'
  | 'RETURN_SPIKE'
  | 'AD_SPEND_SPIKE'
  | 'CHANNEL_DROP'

export interface AnomalyPoint {
  id: string
  date: string
  kind: AnomalyKind
  severity: AnomalySeverity
  headline: string
  observedValue: number
  expectedMean: number
  expectedStd: number
  zScore: number
  context?: { channel?: string }
}

export interface AnomalyReport {
  window: { from: string; to: string }
  referenceWindow: { from: string; to: string }
  items: AnomalyPoint[]
  summary: {
    critical: number
    attention: number
    info: number
  }
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function stats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

function severityFor(z: number): AnomalySeverity {
  const abs = Math.abs(z)
  if (abs >= 3) return 'critical'
  if (abs >= 2.25) return 'attention'
  return 'info'
}

interface Series {
  byDay: Map<string, number>
  channels?: Map<string, Map<string, number>>
}

async function loadSeries(
  from: Date,
  to: Date,
  filters: InsightsFilters,
): Promise<{
  revenue: Series
  orders: Series
  returns: Series
  adSpend: Series
}> {
  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const [orderRows, returnRows, adRows] = await Promise.all([
    prisma.order.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        deletedAt: null,
        ...(whereChannel ? { channel: whereChannel as never } : {}),
        ...(whereMarket ? { marketplace: whereMarket } : {}),
      },
      select: { createdAt: true, totalPrice: true, channel: true },
      take: 100_000,
    }),
    prisma.return.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: { createdAt: true },
      take: 50_000,
    }),
    prisma.amazonAdsDailyPerformance.findMany({
      where: {
        date: { gte: from, lt: to },
        ...(filters.markets.length > 0
          ? { marketplace: { in: filters.markets } }
          : {}),
      },
      select: { date: true, costMicros: true },
      take: 200_000,
    }),
  ])

  const revenue: Series = { byDay: new Map(), channels: new Map() }
  const orders: Series = { byDay: new Map(), channels: new Map() }
  for (const o of orderRows) {
    const dk = dayKey(o.createdAt)
    revenue.byDay.set(dk, (revenue.byDay.get(dk) ?? 0) + Number(o.totalPrice ?? 0))
    orders.byDay.set(dk, (orders.byDay.get(dk) ?? 0) + 1)
    const channelMap = revenue.channels!.get(o.channel) ?? new Map()
    channelMap.set(dk, (channelMap.get(dk) ?? 0) + Number(o.totalPrice ?? 0))
    revenue.channels!.set(o.channel, channelMap)
  }
  const returnsSeries: Series = { byDay: new Map() }
  for (const r of returnRows) {
    const dk = dayKey(r.createdAt)
    returnsSeries.byDay.set(dk, (returnsSeries.byDay.get(dk) ?? 0) + 1)
  }
  const adSpend: Series = { byDay: new Map() }
  for (const r of adRows) {
    const dk = dayKey(r.date)
    adSpend.byDay.set(
      dk,
      (adSpend.byDay.get(dk) ?? 0) + Number(r.costMicros) / 1_000_000,
    )
  }
  return { revenue, orders, returns: returnsSeries, adSpend }
}

function detectFromSeries(
  series: Series,
  windowDays: string[],
  referenceDays: string[],
  spikeKind: AnomalyKind,
  dropKind: AnomalyKind,
  formatValue: (v: number) => string,
  invertDrop = false,
): AnomalyPoint[] {
  const referenceValues = referenceDays
    .map((d) => series.byDay.get(d) ?? 0)
    .filter((_, i, arr) => i < arr.length - windowDays.length)
  if (referenceValues.length < 14) return []
  const { mean, std } = stats(referenceValues)
  if (std === 0) return []
  const items: AnomalyPoint[] = []
  for (const dk of windowDays) {
    const v = series.byDay.get(dk) ?? 0
    const z = (v - mean) / std
    if (Math.abs(z) < 2) continue
    const kind = z > 0 ? spikeKind : dropKind
    const severity = severityFor(z)
    const isSpike = z > 0
    items.push({
      id: `${kind}-${dk}`,
      date: dk,
      kind,
      severity: invertDrop && isSpike ? 'attention' : severity,
      headline: `${isSpike ? 'Spike' : 'Drop'}: ${formatValue(v)} on ${dk}, expected ~${formatValue(mean)} (z=${z.toFixed(1)})`,
      observedValue: Math.round(v),
      expectedMean: Math.round(mean),
      expectedStd: Math.round(std * 10) / 10,
      zScore: Math.round(z * 10) / 10,
    })
  }
  return items
}

export async function computeAnomalies(
  filters: InsightsFilters,
): Promise<AnomalyReport> {
  const current = resolveWindowRange(filters)
  const referenceFrom = new Date(current.to.getTime() - 90 * 24 * 3600_000)
  const reference = { from: referenceFrom, to: current.to }

  const referenceData = await loadSeries(reference.from, reference.to, filters)

  const dayMs = 24 * 3600_000
  const windowDays: string[] = []
  for (let t = current.from.getTime(); t < current.to.getTime(); t += dayMs) {
    windowDays.push(dayKey(new Date(t)))
  }
  const referenceDays: string[] = []
  for (let t = reference.from.getTime(); t < reference.to.getTime(); t += dayMs) {
    referenceDays.push(dayKey(new Date(t)))
  }

  const fmtEur = (v: number) =>
    new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v)
  const fmtN = (v: number) => new Intl.NumberFormat('it-IT').format(Math.round(v))

  const items: AnomalyPoint[] = [
    ...detectFromSeries(
      referenceData.revenue,
      windowDays,
      referenceDays,
      'REVENUE_SPIKE',
      'REVENUE_DROP',
      fmtEur,
    ),
    ...detectFromSeries(
      referenceData.orders,
      windowDays,
      referenceDays,
      'ORDERS_SPIKE',
      'ORDERS_DROP',
      fmtN,
    ),
    ...detectFromSeries(
      referenceData.returns,
      windowDays,
      referenceDays,
      'RETURN_SPIKE',
      'RETURN_SPIKE',
      fmtN,
      true,
    ).filter((p) => p.zScore > 0),
    ...detectFromSeries(
      referenceData.adSpend,
      windowDays,
      referenceDays,
      'AD_SPEND_SPIKE',
      'AD_SPEND_SPIKE',
      fmtEur,
      true,
    ).filter((p) => p.zScore > 0),
  ]

  if (referenceData.revenue.channels) {
    for (const [channel, byDay] of referenceData.revenue.channels.entries()) {
      const seriesObj: Series = { byDay }
      const channelItems = detectFromSeries(
        seriesObj,
        windowDays,
        referenceDays,
        'REVENUE_SPIKE',
        'CHANNEL_DROP',
        fmtEur,
      ).filter((p) => p.zScore < 0)
      for (const item of channelItems) {
        items.push({
          ...item,
          id: `CHANNEL_DROP-${channel}-${item.date}`,
          headline: `${channel} ${item.headline.toLowerCase()}`,
          context: { channel },
        })
      }
    }
  }

  items.sort(
    (a, b) =>
      ({ critical: 0, attention: 1, info: 2 })[a.severity] -
        ({ critical: 0, attention: 1, info: 2 })[b.severity] ||
      Math.abs(b.zScore) - Math.abs(a.zScore),
  )

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    referenceWindow: {
      from: reference.from.toISOString(),
      to: reference.to.toISOString(),
    },
    items,
    summary: {
      critical: items.filter((i) => i.severity === 'critical').length,
      attention: items.filter((i) => i.severity === 'attention').length,
      info: items.filter((i) => i.severity === 'info').length,
    },
  }
}
