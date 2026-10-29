import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CrViEvidence, CrViMethod, LabTest, Verdict } from '@nexus/factory-domain/quality/lab/rules'
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
}

export interface LabResultStore {
  /** Inside the recording command (its audit row too). */
  record(tools: Pick<CommandTools, 'tx' | 'audit'>, row: LabResultRow): Promise<void>
  /** A lot's results, newest first. */
  list(client: Reader, lotId: string): Promise<LabResultRow[]>
  /** The results that rest on this report file (a supplier report reused for another lot of the article). */
  byFile(client: Reader, fileId: string): Promise<LabResultRow[]>
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

const rowOf = (row: Row): LabResultRow => ({
  ...row,
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
  record: async (tools: Pick<CommandTools, 'tx' | 'audit'>, row: LabResultRow) => {
    await tools.tx.labResult.create({
      data: { ...row, testedOn: day(row.testedOn)!, periodFrom: day(row.periodFrom), periodTo: day(row.periodTo), createdAt: new Date(row.createdAt) },
      select: { id: true },
    })
    tools.audit({
      action: 'quality.labResultRecorded',
      recordType: 'LabResult',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: { lotId: row.lotId, test: row.test, method: row.method, valueMgKg: row.valueMgKg, belowDetectionLimit: row.belowDetectionLimit, detectionLimitMgKg: row.detectionLimitMgKg, limitMgKg: row.limitMgKg, verdict: row.verdict, lab: row.lab, reportNumber: row.reportNumber, testedOn: row.testedOn, evidence: row.evidence, article: row.article, periodFrom: row.periodFrom, periodTo: row.periodTo, fileId: row.fileId, supersedesId: row.supersedesId },
    })
  },
  list: async (client: Reader, lotId: string) => (await client.labResult.findMany({ where: { lotId }, select: COLUMNS, orderBy: NEWEST_FIRST })).map(rowOf),
  byFile: async (client: Reader, fileId: string) => (await client.labResult.findMany({ where: { fileId }, select: COLUMNS, orderBy: NEWEST_FIRST })).map(rowOf),
})

let configured: LabResultStore | undefined

/** Tests may swap the store; `undefined` puts the table back. */
export function useLabResults(store: LabResultStore | undefined): void {
  configured = store
}

export function processLabResults(): LabResultStore {
  return configured ?? TABLE_LAB_RESULTS
}
