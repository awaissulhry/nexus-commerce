import type { CommandTools } from '../../../core/command'
import type { CrViEvidence, CrViMethod, LabTest, Verdict } from '@nexus/factory-domain/quality/lab/rules'
import type { Reader } from './store'

/**
 * THE SEAM for a lot's lab results (B-W1-34). The lab step writes and reads results only through `processLabResults()`,
 * so the store is one file to swap.
 *
 * INTERIM (lead 10-29): there is no LabResult table yet. Until the schema step (approved: `LabResult` @append-only in
 * quality.prisma with `supersedesId`), a result is ONE audit row on its Lot (action `quality.labResultRecorded`,
 * `after.labResult` = the row below), written in the recording command's transaction like every audit row. The lot's
 * own Cr VI columns (status, value, evidence, test day; trigger-checked) stay the gate for release, issue and planning;
 * this store is the history behind them. NOT to be merged: the schema step replaces `AUDIT_LAB_RESULTS` with the table.
 */

export interface LabResultRow {
  readonly id: string
  readonly lotId: string
  readonly companyId: string
  readonly siteId: string
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
  /** Inside the recording command. */
  record(tools: Pick<CommandTools, 'audit'>, row: LabResultRow): Promise<void>
  /** A lot's results, newest first. */
  list(client: Reader, lotId: string): Promise<LabResultRow[]>
  /** The results that rest on this report file (a supplier report reused for another lot of the article). */
  byFile(client: Reader, fileId: string): Promise<LabResultRow[]>
}

export const LAB_RESULT_ACTION = 'quality.labResultRecorded'

const rowOf = (after: unknown): LabResultRow | null => {
  const value = (after as { labResult?: LabResultRow } | null)?.labResult
  return value && typeof value === 'object' && typeof value.id === 'string' ? value : null
}

/** Interim: one audit row per result (see above). */
export const AUDIT_LAB_RESULTS: LabResultStore = Object.freeze({
  record: async (tools: Pick<CommandTools, 'audit'>, row: LabResultRow) => {
    tools.audit({ action: LAB_RESULT_ACTION, recordType: 'Lot', recordId: row.lotId, companyId: row.companyId, siteId: row.siteId, after: { labResult: row } })
  },
  list: async (client: Reader, lotId: string) =>
    (await client.auditLog.findMany({ where: { recordType: 'Lot', recordId: lotId, action: LAB_RESULT_ACTION }, select: { after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] }))
      .map((entry) => rowOf(entry.after))
      .filter((row): row is LabResultRow => row !== null),
  byFile: async (client: Reader, fileId: string) =>
    (await client.auditLog.findMany({ where: { recordType: 'Lot', action: LAB_RESULT_ACTION, after: { path: ['labResult', 'fileId'], equals: fileId } }, select: { after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] }))
      .map((entry) => rowOf(entry.after))
      .filter((row): row is LabResultRow => row !== null),
})

let configured: LabResultStore | undefined

/** Tests (and the schema step) swap the store; `undefined` puts the default back. */
export function useLabResults(store: LabResultStore | undefined): void {
  configured = store
}

export function processLabResults(): LabResultStore {
  return configured ?? AUDIT_LAB_RESULTS
}
