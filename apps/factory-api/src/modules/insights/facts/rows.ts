import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { Measure } from '@nexus/factory-domain/insights/kpis/measures'
import type { WhereClause } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../../core/command'
import type { RateBook } from '../../../platform/currency/service'

/**
 * The shapes of the metric layer's facts in the API (B-W2b-428; ANA-069): what a source collects for one company, and the
 * keys the database holds them by (factory-db FactDaily / FactHourly, B-W2b-381: `fact:<company>:<site|all>:<line|all>:<day>:<measure>`,
 * `facth:<company>:<site|all>:<line|all>:<hour UTC YYYY-MM-DDTHH:MMZ>:<measure>`). A fact holds exactly one number: a count or
 * pieces in `value`, money in minor units of the company's currency in the column of its grain.
 */

export type Reader = FactoryClient | CommandTx

export type FactNumber = { readonly value: string } | { readonly priceAmount: number } | { readonly costAmount: number } | { readonly marginAmount: number }

export interface DayFact {
  readonly companyId: string
  readonly siteId: string | null
  readonly lineId: string | null
  readonly day: BusinessDate
  readonly measureKey: string
  readonly number: FactNumber
}

export interface HourFact extends DayFact {
  readonly hourStart: Date
}

export interface Collected {
  readonly daily: DayFact[]
  readonly hourly: HourFact[]
}

export interface FactSite {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

export interface FactCompany {
  readonly id: string
  readonly code: string
  readonly currency: string
  readonly timezone: string
  readonly fiscalYearStartMonth: number
  readonly sites: readonly FactSite[]
}

/** What a source reads for one company: its days (each up to that place's today), the rates, and a reader's own scope. */
export interface CollectInput {
  readonly company: FactCompany
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly now: Date
  readonly rates: RateBook
  /**
   * A reader whose grant is limited to some customers (a party-scoped measure): the records' own scope filter (scopeWhere),
   * and the source collects only those records; the facts are never written from it.
   */
  readonly where?: WhereClause
}

export type Source = (db: Reader, input: CollectInput) => Promise<Collected>

/** A fact's number for a measure: a quantity in `value`, money in the column of its grain. */
export function numberOf(measure: Measure, amount: number | string): FactNumber {
  if (measure.unit !== 'MONEY') return { value: String(amount) }
  const minor = typeof amount === 'number' ? amount : Number.parseInt(amount, 10)
  if (measure.grain === 'price') return { priceAmount: minor }
  if (measure.grain === 'cost') return { costAmount: minor }
  return { marginAmount: minor }
}

export const dailyKey = (fact: Pick<DayFact, 'companyId' | 'siteId' | 'lineId' | 'day' | 'measureKey'>): string =>
  `fact:${fact.companyId}:${fact.siteId ?? 'all'}:${fact.lineId ?? 'all'}:${fact.day}:${fact.measureKey}`

export const hourlyKey = (fact: Pick<HourFact, 'companyId' | 'siteId' | 'lineId' | 'hourStart' | 'measureKey'>): string =>
  `facth:${fact.companyId}:${fact.siteId ?? 'all'}:${fact.lineId ?? 'all'}:${fact.hourStart.toISOString().slice(0, 16)}Z:${fact.measureKey}`

/** The companies of the tenant (or those named) with their sites, as the facts need them. */
export async function factCompanies(db: Reader, companyIds?: readonly string[]): Promise<FactCompany[]> {
  const companies = await db.company.findMany({
    where: companyIds ? { id: { in: [...companyIds] } } : {},
    select: { id: true, code: true, currency: true, timezone: true, fiscalYearStartMonth: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  const sites = await db.site.findMany({ where: { companyId: { in: companies.map((company) => company.id) } }, select: { id: true, companyId: true, code: true, name: true, timezone: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return companies.map((company) => ({ ...company, sites: sites.filter((site) => site.companyId === company.id) }))
}
