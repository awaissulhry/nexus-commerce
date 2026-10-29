import { isCurrencyCode } from '../core/money'
import type { BusinessDate } from '../core/time'
import type { ItemKind } from '../product/materials/rules'
import type { WorkCentreKind } from '../product/routing/operations'
import type { ItemUnits } from '../product/units/units'

/**
 * What a cost sheet is priced with (features FIN-002, FIN-004, FIN-005, GAP-006), pure: the materials with their
 * standard purchase price, the labour rates per kind of work centre and the overhead rule, as data. Where they are kept
 * is the API's business (apps/factory-api modules/costing/inputs.ts): this module only chooses among them.
 *
 *   material price   Item.standardCost: per BASE unit of the material, in its currency (GAP-006; supplier price lists
 *                    are W2a). The BOM's requirement is in base units too, so a hide-bought leather costed per ft² needs
 *                    no conversion here: the units module has already turned the line's quantity into base units.
 *   labour rate      the cost of one standard minute at a kind of work centre, with the planned efficiency it assumes
 *                    (FIN-004: labour = minutes × cost per minute ÷ efficiency), valid from a day; a company's own rate
 *                    wins over the tenant-wide one, the newest valid one of each.
 *   overhead         a percentage on material + labour (the old app's rule), the company's or else the tenant's.
 */

/** Where a material's cost shows on the sheet (the design: leather apart, then the other materials, trims and labels, packaging). */
export const COST_CATEGORIES = ['LEATHER', 'MATERIALS', 'TRIMS', 'PACKAGING'] as const
export type CostCategory = (typeof COST_CATEGORIES)[number]

const CATEGORY_OF: Readonly<Record<ItemKind, CostCategory>> = Object.freeze({
  LEATHER: 'LEATHER',
  TEXTILE: 'MATERIALS',
  LINING: 'MATERIALS',
  MEMBRANE: 'MATERIALS',
  PADDING: 'MATERIALS',
  PROTECTOR: 'MATERIALS',
  COMPONENT: 'MATERIALS',
  THREAD: 'TRIMS',
  TRIM: 'TRIMS',
  HARDWARE: 'TRIMS',
  LABEL: 'TRIMS',
  PACKAGING: 'PACKAGING',
})

export const categoryOf = (kind: ItemKind): CostCategory => CATEGORY_OF[kind]

/** Where a material's price comes from. W1: the typed standard price only (last purchase, contract and average are W2a). */
export const PRICE_SOURCES = ['STANDARD'] as const
export type PriceSource = (typeof PRICE_SOURCES)[number]

/** A BOM line's material as costing reads it. */
export interface CostingMaterial {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: ItemKind
  readonly units: ItemUnits
  /** Per base unit, a plain decimal; null: no standard price typed (the sheet says so, never 0). */
  readonly standardCost: string | null
  readonly currency: string
  /** When the price was last set (an ISO instant), if known. */
  readonly priceAsOf: string | null
}

/** The cost of one standard minute at a kind of work centre. */
export interface LabourRate {
  readonly id: string
  /** null: tenant-wide. */
  readonly companyId: string | null
  readonly workCentreKind: WorkCentreKind
  /** A plain decimal, per standard minute. */
  readonly costPerMinute: string
  readonly currency: string
  /** Percent, above 0: 100 means the minutes are worked as planned. */
  readonly plannedEfficiencyPct: string
  readonly validFrom: BusinessDate
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** The overhead rule: a percentage on material + labour. */
export interface OverheadRule {
  readonly id: string
  /** null: tenant-wide. */
  readonly companyId: string | null
  /** A plain decimal, percent. */
  readonly overheadPct: string
  readonly updatedAt: string | null
}

/**
 * The rate a sheet for `companyId` uses for a kind of work centre on `on`: among the ACTIVE rates of that kind valid
 * on that day (validFrom ≤ on), the company's own newest one, else the tenant-wide newest one; null when there is none.
 */
export function pickRate(rates: readonly LabourRate[], workCentreKind: WorkCentreKind, companyId: string | null, on: BusinessDate): LabourRate | null {
  const valid = rates.filter((rate) => rate.status === 'ACTIVE' && rate.workCentreKind === workCentreKind && rate.validFrom <= on)
  const newest = (list: readonly LabourRate[]): LabourRate | null =>
    list.reduce<LabourRate | null>((best, rate) => (best === null || rate.validFrom > best.validFrom || (rate.validFrom === best.validFrom && rate.id > best.id) ? rate : best), null)
  return (companyId === null ? null : newest(valid.filter((rate) => rate.companyId === companyId))) ?? newest(valid.filter((rate) => rate.companyId === null))
}

/** The overhead rule a sheet for `companyId` uses: the company's own, else the tenant-wide one; null when neither is set. */
export function pickOverhead(rules: readonly OverheadRule[], companyId: string | null): OverheadRule | null {
  return (companyId === null ? undefined : rules.find((rule) => rule.companyId === companyId)) ?? rules.find((rule) => rule.companyId === null) ?? null
}

/** The currency a sheet is costed in: the company's base currency; with no company, EUR (every price and rate defaults to it). */
export const DEFAULT_COSTING_CURRENCY = 'EUR'

export function costingCurrency(companyCurrency: string | null): string {
  return companyCurrency !== null && isCurrencyCode(companyCurrency) ? companyCurrency : DEFAULT_COSTING_CURRENCY
}
