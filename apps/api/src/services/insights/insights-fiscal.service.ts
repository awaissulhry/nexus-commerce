/**
 * IH.8 — Italian fiscal & compliance insights.
 *
 * Builds the commercialista-friendly view of the operator's tax
 * footprint. Surfaces:
 *
 *   • Quarterly IVA (VAT) breakdown by rate (22% standard, 10%
 *     reduced, 4% super-reduced) from OrderItem.itVatRatePct
 *   • B2B vs B2C split (Order.fiscalKind) — drives FatturaPA SDI
 *     submission cadence + corrispettivi reporting
 *   • OSS (One-Stop Shop) per-country cross-border VAT exposure
 *     for EU sales outside Italy
 *   • Intrastat-ready goods movement summary by destination country
 *   • Settlement reconciliation panel — orders + refunds vs the
 *     credit-notes ledger
 *   • Multi-currency P&L bridge with primary-currency rollup
 *
 * The Italian fiscal year is calendar-aligned; we offer YTD + per-
 * quarter slices. Quarter boundaries are computed in Europe/Rome
 * so the dashboard tracks the same fiscal periods the operator's
 * commercialista uses.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
} from './index.js'

const EU_COUNTRIES = [
  'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'AT', 'PT', 'IE', 'FI',
  'GR', 'SE', 'DK', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR',
  'SI', 'EE', 'LV', 'LT', 'LU', 'MT', 'CY',
]

export interface IvaRateBucket {
  ratePct: number
  label: string
  taxableBase: number
  vatAmount: number
  orderCount: number
}

export interface OssCountryRow {
  country: string
  orderCount: number
  taxableBase: number
  vatAmount: number
}

export interface FiscalKindBucket {
  key: string
  label: string
  orderCount: number
  revenue: number
}

export interface SettlementChannelRow {
  channel: string
  ordersRevenue: number
  refundsValue: number
  netSettlement: number
  ordersCount: number
  refundsCount: number
}

export interface CurrencyBridgeRow {
  code: string
  revenue: number
  share: number
}

export interface CreditNoteLedgerRow {
  id: string
  noteNumber: string | null
  refundId: string
  amount: number
  issuedAt: string
}

export interface FiscalReport {
  window: { from: string; to: string }
  fiscalYear: number
  quarter: number
  totals: {
    grossRevenue: number
    vatCollected: number
    netRevenue: number
    refundsValue: number
    creditNotesValue: number
    invoiceCount: number
    creditNoteCount: number
    b2bRevenue: number
    b2cRevenue: number
  }
  ivaByRate: IvaRateBucket[]
  fiscalKindMix: FiscalKindBucket[]
  ossByCountry: OssCountryRow[]
  intrastatGoods: OssCountryRow[]
  settlement: SettlementChannelRow[]
  currencyBridge: CurrencyBridgeRow[]
  creditNoteLedger: CreditNoteLedgerRow[]
}

function quarterOf(d: Date): number {
  const month = parseInt(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      month: '2-digit',
    }).format(d),
    10,
  )
  return Math.ceil(month / 3)
}

function fiscalYearOf(d: Date): number {
  return parseInt(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
    }).format(d),
    10,
  )
}

export async function computeFiscalReport(
  filters: InsightsFilters,
): Promise<FiscalReport> {
  const current = resolveWindowRange(filters)

  const [orders, refunds, invoices, creditNotes] = await Promise.all([
    prisma.order.findMany({
      where: {
        createdAt: { gte: current.from, lt: current.to },
        deletedAt: null,
      },
      select: {
        id: true,
        channel: true,
        marketplace: true,
        fiscalKind: true,
        totalPrice: true,
        currencyCode: true,
        shippingAddress: true,
        items: {
          select: {
            quantity: true,
            price: true,
            itVatRatePct: true,
          },
        },
        fiscalInvoice: { select: { id: true, invoiceNumber: true } },
      },
      take: 50_000,
    }),
    prisma.return.findMany({
      where: {
        createdAt: { gte: current.from, lt: current.to },
      },
      select: {
        id: true,
        refundCents: true,
        currencyCode: true,
        channel: true,
        order: { select: { channel: true } },
      },
      take: 20_000,
    }),
    prisma.fiscalInvoice.findMany({
      where: {
        issuedAt: { gte: current.from, lt: current.to },
      },
      select: { id: true },
      take: 50_000,
    }),
    prisma.creditNote.findMany({
      where: { issuedAt: { gte: current.from, lt: current.to } },
      select: {
        id: true,
        creditNoteNumber: true,
        refundId: true,
        amountCents: true,
        issuedAt: true,
      },
      take: 10_000,
    }),
  ])

  const ivaByRateMap = new Map<number, IvaRateBucket>()
  const fiscalKindMap = new Map<string, FiscalKindBucket>()
  const ossMap = new Map<string, OssCountryRow>()
  const intraMap = new Map<string, OssCountryRow>()
  const currencyMap = new Map<string, number>()
  const settlementMap = new Map<
    string,
    { revenue: number; orderCount: number }
  >()

  let grossRevenue = 0
  let vatCollected = 0
  let b2bRevenue = 0
  let b2cRevenue = 0

  for (const o of orders) {
    const revenue = Number(o.totalPrice ?? 0)
    grossRevenue += revenue

    const code = o.currencyCode ?? 'EUR'
    currencyMap.set(code, (currencyMap.get(code) ?? 0) + revenue)

    const kindKey = o.fiscalKind ?? 'UNSET'
    const kindLabel =
      kindKey === 'B2B' ? 'B2B (invoice)' : kindKey === 'B2C' ? 'B2C (receipt)' : 'Unset'
    const kSlot = fiscalKindMap.get(kindKey) ?? {
      key: kindKey,
      label: kindLabel,
      orderCount: 0,
      revenue: 0,
    }
    kSlot.orderCount += 1
    kSlot.revenue += revenue
    fiscalKindMap.set(kindKey, kSlot)
    if (kindKey === 'B2B') b2bRevenue += revenue
    else if (kindKey === 'B2C') b2cRevenue += revenue

    const addr = (o.shippingAddress as { country?: string } | null) ?? null
    const country = (addr?.country ?? o.marketplace ?? 'IT').toUpperCase()
    for (const it of o.items) {
      const lineRevenue = Number(it.price ?? 0) * (it.quantity ?? 0)
      const rate = it.itVatRatePct == null ? 22 : Number(it.itVatRatePct)
      const taxableBase = lineRevenue / (1 + rate / 100)
      const vatAmount = lineRevenue - taxableBase
      vatCollected += vatAmount

      const slot = ivaByRateMap.get(rate) ?? {
        ratePct: rate,
        label: `${rate}%`,
        taxableBase: 0,
        vatAmount: 0,
        orderCount: 0,
      }
      slot.taxableBase += taxableBase
      slot.vatAmount += vatAmount
      slot.orderCount += 1
      ivaByRateMap.set(rate, slot)

      if (country !== 'IT' && EU_COUNTRIES.includes(country)) {
        const ossSlot = ossMap.get(country) ?? {
          country,
          orderCount: 0,
          taxableBase: 0,
          vatAmount: 0,
        }
        ossSlot.orderCount += 1
        ossSlot.taxableBase += taxableBase
        ossSlot.vatAmount += vatAmount
        ossMap.set(country, ossSlot)
      }
      if (EU_COUNTRIES.includes(country) && country !== 'IT') {
        const iSlot = intraMap.get(country) ?? {
          country,
          orderCount: 0,
          taxableBase: 0,
          vatAmount: 0,
        }
        iSlot.orderCount += 1
        iSlot.taxableBase += taxableBase
        iSlot.vatAmount += vatAmount
        intraMap.set(country, iSlot)
      }
    }

    const sSlot = settlementMap.get(o.channel) ?? { revenue: 0, orderCount: 0 }
    sSlot.revenue += revenue
    sSlot.orderCount += 1
    settlementMap.set(o.channel, sSlot)
  }

  let refundsTotal = 0
  const refundsByChannel = new Map<string, { value: number; count: number }>()
  for (const r of refunds) {
    const value = (r.refundCents ?? 0) / 100
    refundsTotal += value
    const ch = r.channel ?? r.order?.channel ?? 'UNKNOWN'
    const slot = refundsByChannel.get(ch) ?? { value: 0, count: 0 }
    slot.value += value
    slot.count += 1
    refundsByChannel.set(ch, slot)
  }

  const settlement: SettlementChannelRow[] = [
    ...new Set([
      ...settlementMap.keys(),
      ...refundsByChannel.keys(),
    ]),
  ].map((channel) => {
    const orders = settlementMap.get(channel) ?? { revenue: 0, orderCount: 0 }
    const ref = refundsByChannel.get(channel) ?? { value: 0, count: 0 }
    return {
      channel,
      ordersRevenue: Math.round(orders.revenue),
      refundsValue: Math.round(ref.value),
      netSettlement: Math.round(orders.revenue - ref.value),
      ordersCount: orders.orderCount,
      refundsCount: ref.count,
    }
  })

  const currencyTotal = [...currencyMap.values()].reduce((s, v) => s + v, 0)
  const currencyBridge: CurrencyBridgeRow[] = [...currencyMap.entries()]
    .map(([code, value]) => ({
      code,
      revenue: Math.round(value),
      share: currencyTotal > 0 ? value / currencyTotal : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)

  const creditNoteLedger: CreditNoteLedgerRow[] = creditNotes.map((cn) => ({
    id: cn.id,
    noteNumber: cn.creditNoteNumber ?? null,
    refundId: cn.refundId,
    amount: cn.amountCents / 100,
    issuedAt: cn.issuedAt.toISOString(),
  }))
  const creditNotesValue = creditNoteLedger.reduce((s, c) => s + c.amount, 0)

  return {
    window: { from: current.from.toISOString(), to: current.to.toISOString() },
    fiscalYear: fiscalYearOf(current.from),
    quarter: quarterOf(current.from),
    totals: {
      grossRevenue: Math.round(grossRevenue),
      vatCollected: Math.round(vatCollected),
      netRevenue: Math.round(grossRevenue - vatCollected),
      refundsValue: Math.round(refundsTotal),
      creditNotesValue: Math.round(creditNotesValue),
      invoiceCount: invoices.length,
      creditNoteCount: creditNoteLedger.length,
      b2bRevenue: Math.round(b2bRevenue),
      b2cRevenue: Math.round(b2cRevenue),
    },
    ivaByRate: [...ivaByRateMap.values()]
      .map((v) => ({
        ...v,
        taxableBase: Math.round(v.taxableBase),
        vatAmount: Math.round(v.vatAmount),
      }))
      .sort((a, b) => b.taxableBase - a.taxableBase),
    fiscalKindMix: [...fiscalKindMap.values()].map((v) => ({
      ...v,
      revenue: Math.round(v.revenue),
    })),
    ossByCountry: [...ossMap.values()]
      .map((v) => ({
        ...v,
        taxableBase: Math.round(v.taxableBase),
        vatAmount: Math.round(v.vatAmount),
      }))
      .sort((a, b) => b.taxableBase - a.taxableBase),
    intrastatGoods: [...intraMap.values()]
      .map((v) => ({
        ...v,
        taxableBase: Math.round(v.taxableBase),
        vatAmount: Math.round(v.vatAmount),
      }))
      .sort((a, b) => b.taxableBase - a.taxableBase),
    settlement,
    currencyBridge,
    creditNoteLedger,
  }
}

export function fiscalReportToCsv(report: FiscalReport): string {
  const lines: string[] = []
  lines.push('Italian Fiscal Report')
  lines.push(`window,${report.window.from},${report.window.to}`)
  lines.push(`fiscal_year,${report.fiscalYear}`)
  lines.push(`quarter,Q${report.quarter}`)
  lines.push('')
  lines.push('Totals')
  lines.push(`gross_revenue,${report.totals.grossRevenue}`)
  lines.push(`vat_collected,${report.totals.vatCollected}`)
  lines.push(`net_revenue,${report.totals.netRevenue}`)
  lines.push(`refunds_value,${report.totals.refundsValue}`)
  lines.push(`credit_notes_value,${report.totals.creditNotesValue}`)
  lines.push(`b2b_revenue,${report.totals.b2bRevenue}`)
  lines.push(`b2c_revenue,${report.totals.b2cRevenue}`)
  lines.push('')
  lines.push('IVA by rate')
  lines.push('rate_pct,taxable_base,vat_amount,order_count')
  for (const b of report.ivaByRate) {
    lines.push(`${b.ratePct},${b.taxableBase},${b.vatAmount},${b.orderCount}`)
  }
  lines.push('')
  lines.push('OSS by country')
  lines.push('country,orders,taxable_base,vat_amount')
  for (const r of report.ossByCountry) {
    lines.push(`${r.country},${r.orderCount},${r.taxableBase},${r.vatAmount}`)
  }
  lines.push('')
  lines.push('Settlement by channel')
  lines.push('channel,orders_revenue,refunds_value,net_settlement,orders_count,refunds_count')
  for (const s of report.settlement) {
    lines.push(
      `${s.channel},${s.ordersRevenue},${s.refundsValue},${s.netSettlement},${s.ordersCount},${s.refundsCount}`,
    )
  }
  return lines.join('\n')
}
