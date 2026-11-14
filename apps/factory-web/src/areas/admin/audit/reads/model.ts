import type { Translate } from '../../../../lib/i18n/messages'

/**
 * Who looked (SCR-018 section `reads`, B-W2b-413; design admin.audit "Views and downloads of sensitive records (PLT-074)":
 * "'Lucia downloaded cost sheet JK-210 · 10:40'", "Filter by record or person"), pure: the record types the read log keeps
 * (as apps/factory-api platform/audit/reads/registry.ts READ_LOG_RECORD_TYPES, held there by the database's own list), the
 * record named in the address (`?looked=<Type>.<id>`: the record's id only, never a name), a person's search reason, and the
 * words. Rows only: nothing here counts, totals or groups by person (Owner answer W2b-6 question 3 = A).
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

export const isReadLogType = (value: string): value is ReadLogRecordType => (READ_LOG_RECORD_TYPES as readonly string[]).includes(value)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The record the address names (`looked=<Type>.<id>`), or null. */
export function lookedOf(params: { get(name: string): string | null } | null | undefined): { type: ReadLogRecordType; id: string } | null {
  const value = params?.get('looked') ?? ''
  const [type, id] = value.split('.')
  return type && id && isReadLogType(type) && UUID.test(id) ? { type, id } : null
}

/** The address term of a record ("" removes it). */
export const lookedTerm = (record: { type: string; id: string } | null) => (record ? `${record.type}.${record.id}` : '')

/** A person's reads are searched only with a reason of 3 to 500 characters (written first, in the person's history). */
export const reasonProblem = (reason: string): string | null => (reason.trim().length < 3 ? 'reads.error.reason' : reason.trim().length > 500 ? 'reads.error.reasonLong' : null)

/** A record type in words, else the type itself. */
export function typeWords(type: string, t: Translate): string {
  const key = `reads.type.${type}`
  const words = t(key)
  return words === key ? type : words
}

/** A short form of an id ("…3f9a12"), for a record the screen cannot name. */
export const shortId = (id: string) => `…${id.replace(/-/g, '').slice(-6)}`
