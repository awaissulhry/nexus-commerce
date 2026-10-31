import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { LabourRate, OverheadRule } from '@nexus/factory-domain/costing/inputs'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../core/command'

/**
 * Where the cost sheet's labour rates and overhead rules come from: one seam, so the sheet's math (factory-domain
 * costing) never knows where they are kept. `processCostingInputs()` is what the routes use: by default the tables
 * (factory-db `LabourRate`, `CostingSettings`, kept by ./rates); tests and later price sources may swap it with
 * `useCostingInputs(source)` (and put the default back with `useCostingInputs(undefined)`). A kind of work centre with
 * no rate is listed as missing by the sheet, never costed at 0; no settings row means no overhead.
 */
export interface CostingInputSource {
  /** Every rate that may apply to a sheet for this company: the company's own and the tenant-wide ones (any day, any status). */
  labourRates(client: FactoryClient | CommandTx, companyId: string | null): Promise<LabourRate[]>
  /** The company's overhead rule and the tenant-wide one, when set. */
  overheadRules(client: FactoryClient | CommandTx, companyId: string | null): Promise<OverheadRule[]>
}

export const RATE_COLUMNS = {
  id: true,
  companyId: true,
  workCentreKind: true,
  costPerMinute: true,
  currency: true,
  plannedEfficiencyPct: true,
  validFrom: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.LabourRateSelect
export type RateRow = Prisma.LabourRateGetPayload<{ select: typeof RATE_COLUMNS }>

export const SETTINGS_COLUMNS = { id: true, companyId: true, overheadPct: true, overheadFromTenant: true, version: true, updatedAt: true } as const satisfies Prisma.CostingSettingsSelect
export type SettingsRow = Prisma.CostingSettingsGetPayload<{ select: typeof SETTINGS_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())
/** A DATE column as its calendar day (Prisma reads it as midnight UTC). */
export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

export const rateOf = (row: RateRow): LabourRate => ({
  id: row.id,
  companyId: row.companyId,
  workCentreKind: row.workCentreKind,
  costPerMinute: text(row.costPerMinute),
  currency: row.currency,
  plannedEfficiencyPct: text(row.plannedEfficiencyPct),
  validFrom: dayOf(row.validFrom),
  status: row.status,
})

/**
 * B-W2b-22 (Z9:02): the rows that carry an overhead of their own. A company's row made for its costing method only
 * (overheadFromTenant, B-W2b-02) follows the tenant-wide overhead: it is left out, so pickOverhead falls to the tenant's.
 */
export const ownOverheadRows = <Row extends { readonly overheadFromTenant: boolean }>(rows: readonly Row[]): Row[] => rows.filter((row) => !row.overheadFromTenant)

/** The company's rows and the tenant-wide ones (only the tenant-wide ones without a company). */
export const companyOrTenant = (companyId: string | null) => ({ OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] })

/** The tables. */
export const TABLE_COSTING_INPUTS: CostingInputSource = Object.freeze({
  labourRates: async (client: FactoryClient | CommandTx, companyId: string | null) =>
    (await client.labourRate.findMany({ where: companyOrTenant(companyId), select: RATE_COLUMNS, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }] })).map(rateOf),
  overheadRules: async (client: FactoryClient | CommandTx, companyId: string | null) =>
    ownOverheadRows(await client.costingSettings.findMany({ where: companyOrTenant(companyId), select: SETTINGS_COLUMNS })).map((row) => ({
      id: row.id,
      companyId: row.companyId,
      overheadPct: text(row.overheadPct),
      updatedAt: toUtcIso(row.updatedAt),
    })),
})

/** No rate and no overhead rule (every kind of work centre is then listed as missing). */
export const NO_COSTING_INPUTS: CostingInputSource = Object.freeze({
  labourRates: async () => [],
  overheadRules: async () => [],
})

let configured: CostingInputSource | undefined

export function useCostingInputs(source: CostingInputSource | undefined): void {
  configured = source
}

export function processCostingInputs(): CostingInputSource {
  return configured ?? TABLE_COSTING_INPUTS
}
