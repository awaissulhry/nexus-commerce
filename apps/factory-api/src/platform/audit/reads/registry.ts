import type { FactoryClient, ReadAction } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'

/**
 * The sensitive records' office routes whose answer is a view or a download (B-W2b-399; PLT-074; Owner answer W2b-6
 * question 3 = A): one line per route, `'<METHOD> <path>'` as its manifest names it. reads/hooks.ts writes one ReadLog row
 * per record a route's successful answer shows to an office person, BEFORE the answer leaves. Only the record types of the
 * database's list (`factory_read_log_record_type_ok`, READ_LOG_RECORD_TYPES below): cost sheets, personal data (people,
 * accounts, contacts, measurements, leavers, absences, attendance, earnings, pay statements, a person's data request),
 * certificates and training records, exports. A record OPENED (its own page: one row, not one per tab), a file or PDF
 * DOWNLOADED; an export is logged when it is made (security-events/ledgers.ts) and when its file is downloaded. Lists are not
 * reads of a record (an export of a list is). A module that adds a route that opens or downloads one of these adds its line
 * here (B-W2b-418/420: the cost sheet's own routes, as CostSheet rows exist); the PG test holds every key to a served route.
 */

export const READ_LOG_RECORD_TYPES = [
  'CostSheet',
  'Employee',
  'Worker',
  'User',
  'PartyContact',
  'MeasurementProfile',
  'LeaverCase',
  'AbsenceEntry',
  'AttendanceDay',
  'EarningsEntry',
  'WorkerStatement',
  'DataRequest',
  'Certificate',
  'TrainingRecord',
  'ExportJob',
  'AccountingExport',
  'PayrollExport',
] as const
export type ReadLogRecordType = (typeof READ_LOG_RECORD_TYPES)[number]

export const isReadLogRecordType = (value: string): value is ReadLogRecordType => (READ_LOG_RECORD_TYPES as readonly string[]).includes(value)

export interface ReadTarget {
  readonly recordType: ReadLogRecordType
  readonly recordId: string
}

type Params = Readonly<Record<string, string | undefined>>

export interface ReadRoute {
  readonly action: ReadAction
  /** The records the answer showed: from the path, or (a file) read in the caller's own scope. */
  targets(params: Params, client: FactoryClient): Promise<readonly ReadTarget[]>
}

/** The record named by a path parameter. */
const byParam = (action: ReadAction, recordType: ReadLogRecordType, param: string): ReadRoute => ({
  action,
  async targets(params) {
    const id = params[param]
    return id && isUuid(id) ? [{ recordType, recordId: id }] : []
  },
})

/** A stored file of a sensitive record (a certificate's PDF, an employee's document, an export's file): its record. */
const fileOfRecord: ReadRoute = {
  action: 'DOWNLOAD',
  async targets(params, client) {
    const id = params.fileId
    if (!id || !isUuid(id)) return []
    const file = await client.storedFile.findUnique({ where: { id }, select: { recordType: true, recordId: true } })
    return file && isReadLogRecordType(file.recordType) ? [{ recordType: file.recordType, recordId: file.recordId }] : []
  },
}

export const READ_ROUTES: Readonly<Record<string, ReadRoute>> = {
  // Personal data: a record opened.
  'GET /people/employees/:employeeId': byParam('VIEW', 'Employee', 'employeeId'),
  'GET /people/leavers/:caseId': byParam('VIEW', 'LeaverCase', 'caseId'),
  'GET /people/attendance/days/:dayId': byParam('VIEW', 'AttendanceDay', 'dayId'),
  'GET /people/earnings/entries/:entryId': byParam('VIEW', 'EarningsEntry', 'entryId'),
  'POST /people/statements/:statementId/open': byParam('VIEW', 'WorkerStatement', 'statementId'),
  'GET /sales/measurement-profiles/:profileId/sent': byParam('VIEW', 'MeasurementProfile', 'profileId'),
  // Personal data: downloaded.
  'POST /people/statements/:statementId/pdf': byParam('DOWNLOAD', 'WorkerStatement', 'statementId'),
  'POST /sales/measurement-profiles/:profileId/photos/:fileId/open': byParam('DOWNLOAD', 'MeasurementProfile', 'profileId'),
  'POST /parties/:partyId/contacts/:contactId/access-copy': byParam('DOWNLOAD', 'PartyContact', 'contactId'),
  // Certificates and training records.
  'GET /compliance/certificates/:certificateId': byParam('VIEW', 'Certificate', 'certificateId'),
  'GET /safety/training/records/:recordId/pdf': byParam('DOWNLOAD', 'TrainingRecord', 'recordId'),
  // Exports: opened and downloaded (made: security-events/ledgers.ts).
  'GET /accounting/exports/:exportId': byParam('VIEW', 'AccountingExport', 'exportId'),
  'GET /accounting/exports/:exportId/files/:fileId/download': byParam('DOWNLOAD', 'AccountingExport', 'exportId'),
  'POST /people/payroll/exports/:exportId/values': byParam('VIEW', 'PayrollExport', 'exportId'),
  'POST /people/payroll/exports/:exportId/files/:fileId/open': byParam('DOWNLOAD', 'PayrollExport', 'exportId'),
  'GET /exports/:exportId/download': byParam('DOWNLOAD', 'ExportJob', 'exportId'),
  // Any file of a sensitive record, downloaded or previewed.
  'GET /files/:fileId/download': fileOfRecord,
  'GET /files/:fileId/preview': fileOfRecord,
}
