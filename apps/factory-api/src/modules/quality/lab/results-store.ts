import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CrViEvidence, CrViMethod, LabTest, Verdict } from '@nexus/factory-domain/quality/lab/rules'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools } from '../../../core/command'
import { dayOf, decimalOrNull, type Reader } from './store'

/**
 * THE SEAM for a lot's lab results (B-W1-34; QHS-029): the lab step writes and reads results only through
 * `processLabResults()`. The default is the table (factory-db quality.prisma `LabResult`, append-only: a later FAIL is a
 * new row that supersedes the PASS; the …_quality_lab_guards trigger checks the verdict against the lot's limit again).
 * The lot's own Cr VI columns (status, value, evidence, test day; the Lot trigger) stay the gate for release, issue and
 * planning; this is the history behind them. Tests may swap the store with `useLabResults`.
 */

export interface LabResultRow {
  readonly id: string
  readonly lotId: string
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  readonly test: LabTest
  readonly method: CrViMethod
  /** Three decimals; null below the detection limit. */
  readonly valueMgKg: string | null
  readonly belowDetectionLimit: boolean
  readonly detectionLimitMgKg: string | null
  readonly unit: 'mg/kg'
  /** The lot's limit it was judged against. */
  readonly limitMgKg: string
  readonly verdict: Verdict
  readonly lab: string
  readonly reportNumber: string | null
  readonly testedOn: string
  readonly evidence: CrViEvidence
  readonly article: string | null
  readonly periodFrom: string | null
  readonly periodTo: string | null
  /** The report (a CERTIFICATE file of this lot, or of the lot whose supplier report it reuses). */
  readonly fileId: string
  /** The earlier result a later FAIL supersedes. */
  readonly supersedesId: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly createdById: string | null
  /**
   * B-W2b-288 (FU2:03): the lab's price of this result, typed with it (money.cost: minor units + ISO 4217 currency), or none.
   * Written once with the row (append-only); never read by `list` or `byFile` (the floor's grant hides it): `costs` reads it,
   * for the office with the cost grain.
   */
  readonly cost?: LabCost | null
}

/** B-W2b-288 (FU2:03): the lab's price of one result. */
export interface LabCost {
  /** Minor units (cents), 0 or more (a contract field named `cents`: not a money-looking name, the object is the cost grain). */
  readonly cents: number
  /** ISO 4217 ("EUR"). */
  readonly currency: string
}

/** B-W2b-288 (FU2:03): one result's lab price, as the office reads it. */
export interface LabResultCost extends LabCost {
  readonly resultId: string
  readonly lotId: string
}

export interface LabResultStore {
  /** Inside the recording command (its audit row too). */
  record(tools: Pick<CommandTools, 'tx' | 'audit'>, row: LabResultRow): Promise<void>
  /** A lot's results, newest first. */
  list(client: Reader, lotId: string): Promise<LabResultRow[]>
  /** The results that rest on this report file (a supplier report reused for another lot of the article). */
  byFile(client: Reader, fileId: string): Promise<LabResultRow[]>
  /**
   * B-W2b-288 (FU2:03): the lab prices of these lots' results (the ones that have one), newest first. OFFICE ONLY and only
   * for a caller with the cost grain (money.cost): the floor's grant on LabResult hides both cost columns.
   */
  costs(client: Reader, lotIds: readonly string[]): Promise<LabResultCost[]>
}

const COLUMNS = {
  id: true,
  lotId: true,
  companyId: true,
  siteId: true,
  itemId: true,
  test: true,
  method: true,
  valueMgKg: true,
  belowDetectionLimit: true,
  detectionLimitMgKg: true,
  unit: true,
  limitMgKg: true,
  verdict: true,
  lab: true,
  reportNumber: true,
  testedOn: true,
  evidence: true,
  article: true,
  periodFrom: true,
  periodTo: true,
  fileId: true,
  supersedesId: true,
  note: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.LabResultSelect
type Row = Prisma.LabResultGetPayload<{ select: typeof COLUMNS }>
// W2b-4 (B-W2b-217): LabTest grew (AZO, NICKEL, PAH, DMFU, NPE, PFAS). This is W1's chromium VI store: it reads CR_VI rows
// only (the other tests' results are B-W2b-256's).
const CR_VI_ONLY = { test: 'CR_VI' } as const

const rowOf = (row: Row): LabResultRow => ({
  ...row,
  test: 'CR_VI',
  method: row.method as CrViMethod,
  valueMgKg: decimalOrNull(row.valueMgKg),
  detectionLimitMgKg: decimalOrNull(row.detectionLimitMgKg),
  unit: 'mg/kg',
  limitMgKg: decimalOrNull(row.limitMgKg)!,
  testedOn: dayOf(row.testedOn),
  periodFrom: row.periodFrom ? dayOf(row.periodFrom) : null,
  periodTo: row.periodTo ? dayOf(row.periodTo) : null,
  createdAt: toUtcIso(row.createdAt),
})

const day = (value: string | null): Date | null => (value === null ? null : new Date(`${value}T00:00:00.000Z`))
const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

/** The table. */
export const TABLE_LAB_RESULTS: LabResultStore = Object.freeze({
  record: async (tools: Pick<CommandTools, 'tx' | 'audit'>, { cost, ...row }: LabResultRow) => {
    await tools.tx.labResult.create({
      // B-W2b-288 (FU2:03): the lab's price, both columns or neither (the LabResult_w2b5_cost guard).
      data: { ...row, testedOn: day(row.testedOn)!, periodFrom: day(row.periodFrom), periodTo: day(row.periodTo), createdAt: new Date(row.createdAt), costAmount: cost?.cents ?? null, costCurrency: cost?.currency ?? null },
      select: { id: true },
    })
    tools.audit({
      action: 'quality.labResultRecorded',
      recordType: 'LabResult',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: {
        lotId: row.lotId,
        test: row.test,
        method: row.method,
        valueMgKg: row.valueMgKg,
        belowDetectionLimit: row.belowDetectionLimit,
        detectionLimitMgKg: row.detectionLimitMgKg,
        limitMgKg: row.limitMgKg,
        verdict: row.verdict,
        lab: row.lab,
        reportNumber: row.reportNumber,
        testedOn: row.testedOn,
        evidence: row.evidence,
        article: row.article,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        fileId: row.fileId,
        supersedesId: row.supersedesId,
        // B-W2b-288 (FU2:03): the lab's price in the audit row, marked with its grain.
        ...(cost ? { cost: markMoney('cost', cost) } : {}),
      },
    })
  },
  list: async (client: Reader, lotId: string) => (await client.labResult.findMany({ where: { lotId, ...CR_VI_ONLY }, select: COLUMNS, orderBy: NEWEST_FIRST })).map(rowOf),
  byFile: async (client: Reader, fileId: string) => (await client.labResult.findMany({ where: { fileId, ...CR_VI_ONLY }, select: COLUMNS, orderBy: NEWEST_FIRST })).map(rowOf),
  // B-W2b-288 (FU2:03): office only (the floor cannot select these columns).
  costs: async (client: Reader, lotIds: readonly string[]) =>
    lotIds.length === 0
      ? []
      : (await client.labResult.findMany({ where: { lotId: { in: [...lotIds] }, costAmount: { not: null }, ...CR_VI_ONLY }, select: { id: true, lotId: true, costAmount: true, costCurrency: true }, orderBy: NEWEST_FIRST })).map((row) => ({
          resultId: row.id,
          lotId: row.lotId,
          cents: row.costAmount!,
          currency: row.costCurrency!,
        })),
})

/** B-W2b-288 (FU2:03): a lot's lab prices in one currency. */
export interface LabCostSum {
  readonly currency: string
  readonly cents: number
  readonly results: number
}

/** B-W2b-288 (FU2:03): the lab prices of each lot's results, summed per currency (currency order). */
export function labCostsByLot(costs: readonly LabResultCost[]): Map<string, LabCostSum[]> {
  const out = new Map<string, Map<string, { cents: number; results: number }>>()
  for (const cost of costs) {
    const lot = out.get(cost.lotId) ?? new Map<string, { cents: number; results: number }>()
    const sum = lot.get(cost.currency) ?? { cents: 0, results: 0 }
    lot.set(cost.currency, { cents: sum.cents + cost.cents, results: sum.results + 1 })
    out.set(cost.lotId, lot)
  }
  return new Map([...out].map(([lotId, sums]) => [lotId, [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, sum]) => ({ currency, ...sum }))]))
}

let configured: LabResultStore | undefined

/** Tests may swap the store; `undefined` puts the table back. */
export function useLabResults(store: LabResultStore | undefined): void {
  configured = store
}

export function processLabResults(): LabResultStore {
  return configured ?? TABLE_LAB_RESULTS
}
