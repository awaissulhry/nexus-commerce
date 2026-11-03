import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { CHECKLIST_ITEMS } from '@nexus/factory-domain/quality/final/rules'
import { isSystemEntry } from '@nexus/factory-domain/quality/final/plan'
import { QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { normalValue, SIGNED_STATES, type AmendedRecord, type AmendedRow, type AmendValue, type RowFacts } from '@nexus/factory-domain/quality/amendments/rules'
import type { CheckType } from '@nexus/factory-domain/quality/plans/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * The records a correction is of, and the rows of each it may be on (B-W2b-123; factory-db quality.prisma Inspection and
 * InspectionDefect, inspection-plans.prisma IncomingInspection, IncomingHideResult, InProcessCheck, InspectionCheckResult,
 * InspectionMeasurement). Every read names its columns, selects no relation and runs as the office caller (row-level
 * security: the tenant). Seeing a record is its own module's view permission over its company and site:
 * quality.inspections.view (a final inspection), quality.incoming.view, quality.inprocess.view.
 */

export type Reader = FactoryClient | CommandTx

export const VIEW_OF: Readonly<Record<AmendedRecord, Permission>> = Object.freeze({
  Inspection: QUALITY_INSPECTIONS_VIEW,
  IncomingInspection: QUALITY_INCOMING_VIEW,
  InProcessCheck: QUALITY_INPROCESS_VIEW,
})

/** The record as a correction needs it: its scope, state, signature, label and own note (and a final inspection's W1 checklist). */
export interface AmendedRecordRow {
  readonly type: AmendedRecord
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly status: string
  readonly signatureSha256: string | null
  readonly label: string
  readonly note: string | null
  readonly planVersionId: string | null
  readonly checklist: Prisma.JsonValue | null
}

const KIND_WORDS: Readonly<Record<string, string>> = { FIRST_PIECE: 'First piece', CUTTING: 'Cutting check', ROVING: 'Roving check', END_OF_LINE: 'End of line' }

/** One record of a kind, or null (missing, or another tenant's). */
export async function readRecord(db: Reader, type: AmendedRecord, id: string): Promise<AmendedRecordRow | null> {
  if (!isUuid(id)) return null
  if (type === 'Inspection') {
    const row = await db.inspection.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, status: true, signatureSha256: true, number: true, workOrderId: true, note: true, planVersionId: true, checklist: true } })
    if (!row) return null
    const label = row.number ?? `${(await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true } }))?.number ?? 'WO'} · inspection`
    return { type, id: row.id, companyId: row.companyId, siteId: row.siteId, status: row.status, signatureSha256: row.signatureSha256, label, note: row.note, planVersionId: row.planVersionId, checklist: row.checklist }
  }
  if (type === 'IncomingInspection') {
    const row = await db.incomingInspection.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, status: true, signatureSha256: true, number: true, note: true, planVersionId: true } })
    return row ? { type, id: row.id, companyId: row.companyId, siteId: row.siteId, status: row.status, signatureSha256: row.signatureSha256, label: row.number, note: row.note, planVersionId: row.planVersionId, checklist: null } : null
  }
  const row = await db.inProcessCheck.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, status: true, signatureSha256: true, kind: true, workOrderId: true, note: true, planVersionId: true, decidedAt: true } })
  if (!row) return null
  const order = row.workOrderId ? (await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true } }))?.number : null
  const label = [KIND_WORDS[row.kind] ?? row.kind, order].filter(Boolean).join(' · ')
  return { type, id: row.id, companyId: row.companyId, siteId: row.siteId, status: row.status, signatureSha256: row.signatureSha256, label, note: row.note, planVersionId: row.planVersionId, checklist: null }
}

export const maySee = (context: OfficeContext, record: Pick<AmendedRecordRow, 'type' | 'companyId' | 'siteId'>, permission: Permission = VIEW_OF[record.type]): boolean =>
  can(actorOf(context), permission, { companyId: record.companyId, siteId: record.siteId })

/** The record as the caller may reach it: seen (else 404) and, when asked, the permission over it (else 403). */
export async function recordFor(caller: CommandCaller, context: OfficeContext, type: AmendedRecord, id: string, permission?: Permission): Promise<AmendedRecordRow> {
  const record = await caller.withClient((client) => readRecord(client, type, id))
  if (!record || !maySee(context, record)) throw new NotFoundError(`${type === 'Inspection' ? 'Inspection' : type === 'IncomingInspection' ? 'Incoming inspection' : 'In-process check'} not found.`)
  if (permission && !maySee(context, record, permission)) throw new ForbiddenError(`This needs ${permission} over the record's company and site.`)
  return record
}

export const isSigned = (record: Pick<AmendedRecordRow, 'type' | 'status'>): boolean => SIGNED_STATES[record.type].includes(record.status)

// ---- the rows a correction may be on --------------------------------------------------------------------------------------------

/** A row (or the record itself) with its own values by field, the facts its checks need, and its label. */
export interface AmendableRow {
  readonly type: AmendedRow | null
  readonly id: string | null
  readonly label: string
  /** The row's own value of each field it takes (as signed). */
  readonly values: Readonly<Record<string, AmendValue>>
  readonly facts: RowFacts
  /** A result's check choices (the dialog's list). */
  readonly choices?: readonly string[]
}

const parentWhere = (record: Pick<AmendedRecordRow, 'type' | 'id'>) =>
  record.type === 'Inspection' ? { inspectionId: record.id } : record.type === 'IncomingInspection' ? { incomingInspectionId: record.id } : { inProcessCheckId: record.id }

const dec = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(3))
const W1_WORDS = new Map<string, string>(CHECKLIST_ITEMS.map((item) => [item.code, item.words]))

/** Every row of the record a correction may be on, with its own values (the record itself first). */
export async function amendableRows(db: Reader, record: AmendedRecordRow): Promise<AmendableRow[]> {
  const rows: AmendableRow[] = []
  const recordValues: Record<string, AmendValue> = { note: normalValue('note', record.note) }
  if (record.type === 'Inspection' && !record.planVersionId && Array.isArray(record.checklist)) {
    for (const entry of record.checklist as unknown[]) {
      const line = entry as { code?: unknown; note?: unknown } | null
      if (!line || typeof line.code !== 'string' || isSystemEntry(line.code)) continue
      recordValues[`checklist.${line.code}.note`] = normalValue('note', line.note)
    }
  }
  rows.push({ type: null, id: null, label: record.label, values: recordValues, facts: {} })

  const where = parentWhere(record)
  const results = await db.inspectionCheckResult.findMany({ where, select: { id: true, planCheckId: true, sampleIndex: true, outcome: true, value: true, note: true }, orderBy: [{ planCheckId: 'asc' }, { sampleIndex: 'asc' }] })
  const checkIds = [...new Set(results.map((row) => row.planCheckId))]
  const checks = checkIds.length === 0 ? [] : await db.inspectionPlanCheck.findMany({ where: { id: { in: checkIds } }, select: { id: true, code: true, sortOrder: true, type: true, nominal: true, tolerance: true, choices: true } })
  const checkOf = new Map(checks.map((check) => [check.id, check]))
  const ordered = [...results].sort((a, b) => (checkOf.get(a.planCheckId)?.sortOrder ?? 0) - (checkOf.get(b.planCheckId)?.sortOrder ?? 0) || a.sampleIndex - b.sampleIndex)
  for (const row of ordered) {
    const check = checkOf.get(row.planCheckId)
    if (!check) continue
    rows.push({
      type: 'InspectionCheckResult',
      id: row.id,
      label: `${check.code} · unit ${row.sampleIndex}`,
      values: { value: normalValue('value', row.value), note: normalValue('note', row.note) },
      facts: { check: { type: check.type as CheckType, code: check.code, nominal: dec(check.nominal), tolerance: dec(check.tolerance), choices: [...check.choices] }, outcome: row.outcome as 'PASS' | 'FAIL' | 'NOT_APPLICABLE' },
      choices: [...check.choices],
    })
  }

  const measurements = await db.inspectionMeasurement.findMany({ where, select: { id: true, pointCode: true, size: true, sampleIndex: true, nominal: true, tolerance: true, measured: true, pass: true }, orderBy: [{ pointCode: 'asc' }, { size: 'asc' }, { sampleIndex: 'asc' }] })
  for (const row of measurements) {
    rows.push({
      type: 'InspectionMeasurement',
      id: row.id,
      label: `${row.pointCode}${row.size ? ` · size ${row.size}` : ''} · unit ${row.sampleIndex}`,
      values: { measured: normalValue('decimal', row.measured.toFixed(3)) },
      facts: { measurement: { pointCode: row.pointCode, nominal: row.nominal.toFixed(3), tolerance: row.tolerance.toFixed(3), pass: row.pass } },
    })
  }

  if (record.type === 'Inspection') {
    const defects = await db.inspectionDefect.findMany({ where: { inspectionId: record.id }, select: { id: true, defectClass: true, code: true, zone: true, description: true, note: true, causeCodeId: true }, orderBy: [{ defectClass: 'asc' }, { code: 'asc' }] })
    for (const row of defects) {
      rows.push({
        type: 'InspectionDefect',
        id: row.id,
        label: `${row.code} · ${row.defectClass.toLowerCase()}`,
        values: { zone: normalValue('zone', row.zone), description: normalValue('text', row.description), note: normalValue('note', row.note), causeCodeId: normalValue('cause', row.causeCodeId) },
        facts: {},
      })
    }
  }
  if (record.type === 'IncomingInspection') {
    const hides = await db.incomingHideResult.findMany({ where: { incomingInspectionId: record.id }, select: { id: true, seq: true, hideId: true, note: true }, orderBy: { seq: 'asc' } })
    const codes = hides.length === 0 ? new Map<string, string>() : new Map((await db.hide.findMany({ where: { id: { in: hides.map((row) => row.hideId) } }, select: { id: true, code: true } })).map((hide) => [hide.id, hide.code]))
    for (const row of hides) rows.push({ type: 'IncomingHideResult', id: row.id, label: `Hide ${row.seq}${codes.get(row.hideId) ? ` · ${codes.get(row.hideId)}` : ''}`, values: { note: normalValue('note', row.note) }, facts: {} })
  }
  return rows
}

/** The words of a W1 checklist code (English, as W1 keeps them). */
export const checklistWords = (code: string): string => W1_WORDS.get(code) ?? code

/** The active cause codes of the tenant, by id (with their words), for a defect's cause. */
export async function causesOf(db: Reader, language: 'it' | 'en'): Promise<{ active: Set<string>; words: Map<string, string> }> {
  const rows = await db.causeCode.findMany({ select: { id: true, code: true, labelIt: true, labelEn: true, active: true } })
  return { active: new Set(rows.filter((row) => row.active).map((row) => row.id)), words: new Map(rows.map((row) => [row.id, `${language === 'it' ? row.labelIt : row.labelEn} (${row.code})`])) }
}

/** Office people's names, by id. */
export async function namesOf(db: Reader, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && isUuid(id)))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}
