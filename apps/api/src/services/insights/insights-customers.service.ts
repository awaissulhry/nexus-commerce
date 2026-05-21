/**
 * IH.6 — customer insights.
 *
 * Composes RFM segments (CI.1 columns on Customer) with window-scoped
 * order behavior to produce LTV bands, cohort retention, new-vs-
 * returning revenue mix, geography heatmap, and concentration risk.
 *
 * Cohort grid is computed in-process from Order rows rather than a
 * dedicated CustomerCohort table — total cardinality is small enough
 * for Xavia (~9k customers, ~30k orders historically) and the grid
 * is computed for the on-screen window only. A cohort-cache job
 * would land in IH.6.2 if cardinality grows.
 */

import prisma from '../../db.js'
import { type InsightsFilters, resolveWindowRange } from './index.js'

export interface RfmSegment {
  key: string
  label: string
  count: number
  totalSpend: number
}

export interface LtvBand {
  bandKey: string
  label: string
  minCents: number
  count: number
  totalSpendCents: number
}

export interface CohortGridRow {
  cohort: string
  cohortSize: number
  cells: Array<{ monthOffset: number; retainedCount: number; retainedPct: number }>
}

export interface GeoBucket {
  marketplace: string
  customers: number
  revenue: number
}

export interface TopCustomer {
  id: string
  email: string
  name: string | null
  totalOrders: number
  totalSpent: number
  rfmLabel: string | null
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export interface CustomerReport {
  window: { from: string; to: string }
  totals: {
    activeCustomers: number
    newCustomers: number
    returningCustomers: number
    repeatRatePct: number | null
    avgOrdersPerCustomer: number | null
    avgLifetimeValue: number
    revenueNew: number
    revenueReturning: number
    concentrationTop10Pct: number | null
  }
  rfm: RfmSegment[]
  ltvBands: LtvBand[]
  cohort: CohortGridRow[]
  byGeography: GeoBucket[]
  topCustomers: TopCustomer[]
}

const RFM_LABELS: Record<string, string> = {
  CHAMPION: 'Champions',
  LOYAL: 'Loyal',
  POTENTIAL: 'Potential',
  NEW: 'New',
  AT_RISK: 'At risk',
  LOST: 'Lost',
  ONE_TIME: 'One-time',
}

function monthKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
  })
    .format(d)
    .slice(0, 7)
}

function monthOffset(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty! - fy!) * 12 + (tm! - fm!)
}

export async function computeCustomerReport(
  filters: InsightsFilters,
): Promise<CustomerReport> {
  const current = resolveWindowRange(filters)

  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as Array<'AMAZON' | 'EBAY' | 'SHOPIFY'> }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const [windowOrders, customers] = await Promise.all([
    prisma.order.findMany({
      where: {
        purchaseDate: { gte: current.from, lt: current.to },
        deletedAt: null,
        ...(whereChannel ? { channel: whereChannel as never } : {}),
        ...(whereMarket ? { marketplace: whereMarket } : {}),
      },
      select: {
        id: true,
        customerId: true,
        customerEmail: true,
        marketplace: true,
        totalPrice: true,
        purchaseDate: true,
        createdAt: true,
      },
      take: 100_000,
    }),
    prisma.customer.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        totalOrders: true,
        totalSpentCents: true,
        firstOrderAt: true,
        lastOrderAt: true,
        rfmLabel: true,
      },
      take: 100_000,
    }),
  ])

  const customersByEmail = new Map(customers.map((c) => [c.email, c]))
  const customerStats = new Map<
    string,
    { orders: number; revenue: number; isNew: boolean; geo: string }
  >()
  for (const o of windowOrders) {
    const key = o.customerEmail
    if (!key) continue
    const slot = customerStats.get(key) ?? {
      orders: 0,
      revenue: 0,
      isNew: false,
      geo: o.marketplace ?? 'GLOBAL',
    }
    slot.orders += 1
    slot.revenue += Number(o.totalPrice ?? 0)
    customerStats.set(key, slot)
  }
  for (const [email, stats] of customerStats.entries()) {
    const profile = customersByEmail.get(email)
    if (profile?.firstOrderAt && profile.firstOrderAt >= current.from) {
      stats.isNew = true
    }
  }

  const rfmCounts = new Map<string, RfmSegment>()
  for (const c of customers) {
    if (!c.rfmLabel) continue
    const slot = rfmCounts.get(c.rfmLabel) ?? {
      key: c.rfmLabel,
      label: RFM_LABELS[c.rfmLabel] ?? c.rfmLabel,
      count: 0,
      totalSpend: 0,
    }
    slot.count += 1
    slot.totalSpend += Number(c.totalSpentCents) / 100
    rfmCounts.set(c.rfmLabel, slot)
  }

  const ltvBands: LtvBand[] = [
    { bandKey: 'b1', label: '€0–50', minCents: 0, count: 0, totalSpendCents: 0 },
    { bandKey: 'b2', label: '€50–200', minCents: 5_000, count: 0, totalSpendCents: 0 },
    { bandKey: 'b3', label: '€200–500', minCents: 20_000, count: 0, totalSpendCents: 0 },
    { bandKey: 'b4', label: '€500–1k', minCents: 50_000, count: 0, totalSpendCents: 0 },
    { bandKey: 'b5', label: '€1k–5k', minCents: 100_000, count: 0, totalSpendCents: 0 },
    { bandKey: 'b6', label: '€5k+', minCents: 500_000, count: 0, totalSpendCents: 0 },
  ]
  for (const c of customers) {
    const cents = Number(c.totalSpentCents)
    for (let i = ltvBands.length - 1; i >= 0; i--) {
      const band = ltvBands[i]!
      if (cents >= band.minCents) {
        band.count += 1
        band.totalSpendCents += cents
        break
      }
    }
  }

  const allOrders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      ...(whereChannel ? { channel: whereChannel as never } : {}),
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: {
      customerEmail: true,
      purchaseDate: true,
      createdAt: true,
    },
    take: 200_000,
  })
  const firstSeenByCustomer = new Map<string, Date>()
  for (const o of allOrders) {
    if (!o.customerEmail) continue
    // First-seen uses purchaseDate (real first-order time); cohort math
    // becomes meaningless when keyed off DB ingest time (every backfilled
    // customer ends up "first seen today").
    const eventDate = o.purchaseDate ?? o.createdAt
    const existing = firstSeenByCustomer.get(o.customerEmail)
    if (!existing || eventDate < existing) {
      firstSeenByCustomer.set(o.customerEmail, eventDate)
    }
  }
  const cohortMembership = new Map<string, Set<string>>()
  for (const [email, firstDate] of firstSeenByCustomer.entries()) {
    const cohort = monthKey(firstDate)
    const set = cohortMembership.get(cohort) ?? new Set<string>()
    set.add(email)
    cohortMembership.set(cohort, set)
  }
  const cohortRetention = new Map<string, Map<number, Set<string>>>()
  for (const o of allOrders) {
    if (!o.customerEmail) continue
    const firstDate = firstSeenByCustomer.get(o.customerEmail)
    if (!firstDate) continue
    const cohort = monthKey(firstDate)
    const observedMonth = monthKey(o.purchaseDate ?? o.createdAt)
    const offset = monthOffset(cohort, observedMonth)
    if (offset < 0 || offset > 11) continue
    const map = cohortRetention.get(cohort) ?? new Map<number, Set<string>>()
    const slot = map.get(offset) ?? new Set<string>()
    slot.add(o.customerEmail)
    map.set(offset, slot)
    cohortRetention.set(cohort, map)
  }
  const sortedCohorts = [...cohortMembership.keys()].sort().slice(-12)
  const cohort: CohortGridRow[] = sortedCohorts.map((c) => {
    const size = cohortMembership.get(c)!.size
    const cells = Array.from({ length: 12 }, (_, offset) => {
      const retained = cohortRetention.get(c)?.get(offset)?.size ?? 0
      return {
        monthOffset: offset,
        retainedCount: retained,
        retainedPct: size > 0 ? retained / size : 0,
      }
    })
    return { cohort: c, cohortSize: size, cells }
  })

  const byGeoMap = new Map<string, { customers: Set<string>; revenue: number }>()
  for (const o of windowOrders) {
    const geo = o.marketplace ?? 'GLOBAL'
    const slot = byGeoMap.get(geo) ?? { customers: new Set<string>(), revenue: 0 }
    if (o.customerEmail) slot.customers.add(o.customerEmail)
    slot.revenue += Number(o.totalPrice ?? 0)
    byGeoMap.set(geo, slot)
  }
  const byGeography: GeoBucket[] = [...byGeoMap.entries()]
    .map(([marketplace, slot]) => ({
      marketplace,
      customers: slot.customers.size,
      revenue: Math.round(slot.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue)

  const sortedByLtv = [...customers].sort(
    (a, b) => Number(b.totalSpentCents) - Number(a.totalSpentCents),
  )
  const top10Pct = Math.max(1, Math.floor(customers.length * 0.1))
  const top10PctSpend = sortedByLtv
    .slice(0, top10Pct)
    .reduce((s, c) => s + Number(c.totalSpentCents), 0)
  const totalLifetimeSpend = customers.reduce(
    (s, c) => s + Number(c.totalSpentCents),
    0,
  )

  const topCustomers: TopCustomer[] = sortedByLtv.slice(0, 25).map((c) => ({
    id: c.id,
    email: c.email,
    name: c.name,
    totalOrders: c.totalOrders,
    totalSpent: Math.round(Number(c.totalSpentCents) / 100),
    rfmLabel: c.rfmLabel,
    firstOrderAt: c.firstOrderAt?.toISOString() ?? null,
    lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
  }))

  const activeCustomers = customerStats.size
  let newCustomers = 0
  let revenueNew = 0
  let revenueReturning = 0
  for (const stats of customerStats.values()) {
    if (stats.isNew) {
      newCustomers += 1
      revenueNew += stats.revenue
    } else {
      revenueReturning += stats.revenue
    }
  }
  const returningCustomers = activeCustomers - newCustomers
  const repeatRatePct =
    activeCustomers > 0 ? (returningCustomers / activeCustomers) * 100 : null
  const avgOrdersPerCustomer =
    activeCustomers > 0
      ? [...customerStats.values()].reduce((s, x) => s + x.orders, 0) /
        activeCustomers
      : null
  const totalRevenue = [...customerStats.values()].reduce(
    (s, x) => s + x.revenue,
    0,
  )

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    totals: {
      activeCustomers,
      newCustomers,
      returningCustomers,
      repeatRatePct,
      avgOrdersPerCustomer,
      avgLifetimeValue:
        customers.length > 0
          ? Math.round(totalLifetimeSpend / customers.length / 100)
          : 0,
      revenueNew: Math.round(revenueNew),
      revenueReturning: Math.round(revenueReturning),
      concentrationTop10Pct:
        totalLifetimeSpend > 0 ? top10PctSpend / totalLifetimeSpend : null,
    },
    rfm: [...rfmCounts.values()].sort((a, b) => b.count - a.count),
    ltvBands,
    cohort,
    byGeography,
    topCustomers,
  }
}

export function customerReportToCsv(report: CustomerReport): string {
  const lines: string[] = []
  lines.push(
    ['email', 'name', 'orders', 'total_spent', 'rfm_label', 'first_order_at', 'last_order_at'].join(','),
  )
  for (const c of report.topCustomers) {
    lines.push(
      [
        c.email,
        JSON.stringify(c.name ?? ''),
        c.totalOrders,
        c.totalSpent,
        c.rfmLabel ?? '',
        c.firstOrderAt ?? '',
        c.lastOrderAt ?? '',
      ].join(','),
    )
  }
  return lines.join('\n')
}
