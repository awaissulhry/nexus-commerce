import { DEFAULT_YIELD_PERIOD, isYieldPeriod, periodFrom, YIELD_PERIODS, type YieldPeriod } from '@nexus/factory-domain/production/cutboard/yield'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { CutYield, YieldLot } from './api'

/**
 * Production reports' Cutting and yield (B-W2b-130; SCR-240 prr-yield; MES-302), pure: the period in the address (`?yield=7|30|90`
 * days ending on the page's day), who may follow its links, the chart's rows (yield per hide lot against what the BOM expects),
 * where a lot and a cut order open. Never by cutter (SCM-255): per cut order, material, lot and supplier only.
 */

export { YIELD_PERIODS, DEFAULT_YIELD_PERIOD, type YieldPeriod }

/** How many lots the chart draws (the worst first: the API sorts them so); the table lists them all. */
export const CHART_LOTS = 12

/** The period's length from the address (`?yield=`), 30 days by default. */
export function yieldDaysOf(params: { get(name: string): string | null } | null): YieldPeriod {
  const value = Number(params?.get('yield') ?? '')
  return isYieldPeriod(value) ? value : DEFAULT_YIELD_PERIOD
}

/** An address with its `?yield=` set (the default leaves it out). */
export function withYieldDays(href: string, days: YieldPeriod): string {
  const [path, query = ''] = href.split('?')
  const params = new URLSearchParams(query)
  if (days === DEFAULT_YIELD_PERIOD) params.delete('yield')
  else params.set('yield', String(days))
  const text = params.toString()
  return `${path}${text ? `?${text}` : ''}`
}

/** The period the API is asked for: `days` days ending on the page's day. */
export const yieldPeriod = (day: string, days: YieldPeriod): { from: string; to: string } => ({ from: periodFrom(day, days), to: day })

export interface YieldCan {
  /** production.cutting.view: the Cutting page and a cut order. */
  readonly cutting: boolean
  /** inventory.stock.view: a lot's record. */
  readonly lots: boolean
}

export function yieldCanOf(permissions: readonly string[]): YieldCan {
  return { cutting: permissions.includes('production.cutting.view'), lots: permissions.includes('inventory.stock.view') }
}

/** A lot's record (Warehouse › Lots once built, else its panels), for whoever may read stock. */
export const lotHref = (prefix: string, row: Pick<YieldLot, 'lot'>, can: YieldCan): string | null => (can.lots ? `${prefix}${recordAddress({ type: 'Lot', id: row.lot.id, label: row.lot.code }, OFFICE_PAGES)}` : null)

/** Warehouse › Lots, once built, for whoever may read stock. */
export const lotsPageHref = (prefix: string, can: YieldCan): string | null => (can.lots && OFFICE_PAGES.has('/warehouse/lots') ? `${prefix}/warehouse/lots` : null)

/** Production › Cutting, once built, for whoever reads the cutting room. */
export const cuttingHref = (prefix: string, can: YieldCan): string | null => (can.cutting && OFFICE_PAGES.has('/production/cutting') ? `${prefix}/production/cutting` : null)

/** A cut order's record for whoever reads the cutting room (its own page once built, else its panels). */
export const cutOrderHref = (prefix: string, row: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }, can: YieldCan): string | null =>
  can.cutting ? `${prefix}${recordAddress({ type: 'CutOrder', id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId }, OFFICE_PAGES)}` : null

/** The chart's rows: the worst lots first, yield and plan in percent (a lot whose yield is unknown is left out). */
export function lotBars(lots: readonly YieldLot[]): { lot: string; yield: number; planned: number }[] {
  return lots
    .filter((row) => row.yieldPct !== null)
    .slice(0, CHART_LOTS)
    .map((row) => ({ lot: row.lot.code, yield: Number(row.yieldPct), planned: row.plannedPct === null ? 0 : Number(row.plannedPct) }))
}

/** Anything to show: a cut order, a lay or a hide cut in the period. */
export const anythingCut = (report: CutYield): boolean => report.orders.length > 0 || report.fabric.lays + report.fabric.waiting > 0 || report.leather.units.length > 0

/** Below the plan by more than half a point: said in words beside the number. */
export const belowPlan = (variancePct: string | null): boolean => variancePct !== null && Number(variancePct) < -0.5
