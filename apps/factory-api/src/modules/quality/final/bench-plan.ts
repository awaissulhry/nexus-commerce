import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Grant } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_RECORD } from '@nexus/factory-domain/quality/final/permissions'
import {
  changeScans,
  countProblem,
  identityEntry,
  identitySummary,
  inspectedNow,
  keepsSampleEntry,
  PLAN_LIMITS,
  resolveMeasurements,
  resultProblems,
  sampleRejected,
  SAMPLE_ENTRY,
  withEntry,
  withoutEntry,
  type IdentityChange,
  type MeasurementInput,
  type ResultInput,
} from '@nexus/factory-domain/quality/final/plan'
import { defectCounts } from '@nexus/factory-domain/quality/final/rules'
import type { RecordedWhat } from '@nexus/factory-domain/quality-final/events'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { readCells, type LabelHeader } from '../../production/serials/store'
import { inspectorOf, type Inspector } from './access'
import { assertMayTake, assertOwnInspection, inspectionFor, invalid, lockInspection, takeOver } from './inspections'
import { bindingOf, factsReader, identityFacts, measurementsOf, mtmFacts, RESULT_COLUMNS, RESULT_RECORD, type Binding } from './plan'
import { readDefects, type InspectionRow } from './store'
import { sheetOf } from './sheet'

/**
 * Recording a final inspection on its plan (B-W2b-97; QHS-014, QHS-023, QHS-049, QHS-052, QHS-053, QHS-054; design floor.final
 * and quality.inspections "Checks & results", "Measurements", "Sample & AQL", "Required photo set"): office and the site's
 * bench, quality.inspections.record, by the inspection's inspector (or its assignee) while it is OPEN, each write ONE
 * command() on the inspection's row (locked, its version checked and bumped), an audit row and `final_inspection.recorded`.
 * Every answer is the bench sheet (./sheet.ts). The database stays the last word (…_inspection_plans_w2b_guards: a result
 * answers a check of the version frozen on the record, a measurement keeps its check's nominal and the database writes
 * `pass`; W1's guard and the plan's decide at the signature).
 *
 *   PUT  /quality/inspections/:inspectionId/results        { version, results: [{ checkCode, sampleIndex?, outcome | null, value?, note? }] }
 *   PUT  /quality/inspections/:inspectionId/measurements   { version, measurements: [{ checkCode? | pointCode, size?, sampleIndex?, measured | null, nominal?, tolerance?, uom? }] }
 *   POST /quality/inspections/:inspectionId/count          { version, inspected } | { version, add }: the AqlCounter's "+ one piece"
 *   POST /quality/inspections/:inspectionId/identity       { version, add?: [code | null], remove?: [code | NO_NUMBER] }
 *   POST /quality/inspections/:inspectionId/results/:resultId/photos (+ /:fileId/complete)   a photo of a result
 */

interface Recorder {
  readonly recordedById: string | null
  readonly recordedByWorkerId: string | null
  readonly deviceId: string | null
}

const recorderOf = (context: Inspector): Recorder =>
  context.audience === 'floor' ? { recordedById: null, recordedByWorkerId: context.actorId, deviceId: context.deviceId } : { recordedById: context.actorId, recordedByWorkerId: null, deviceId: null }

/** The OPEN inspection on a plan the caller records (its inspector, or its assignee), with its work order and plan. */
async function recordable(caller: CommandCaller, inspectionId: string): Promise<{ context: Inspector; inspection: InspectionRow; header: LabelHeader; binding: Binding }> {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  assertOwnInspection(context, inspection)
  if (inspection.status !== 'OPEN') throw new InvalidStateError(`This inspection is ${inspection.status}; a signed or cancelled inspection never changes (a correction is an amendment).`)
  // B-W2b-213: the first write of an inspection a rule opened takes it (never by one who made its garments).
  await assertMayTake(caller, inspection, header)
  const binding = await caller.withClient((client) => bindingOf(client, inspection))
  return { context, inspection, header, binding }
}

/** The counter's state after a write, for the live message: units inspected and the verdict as it stands. */
async function stateAfter(tx: CommandTx, row: Pick<InspectionRow, 'id' | 'sampleSize' | 'acceptMajor' | 'acceptMinor'>, inspected: number, binding: Binding) {
  const counts = defectCounts(await readDefects(tx, [row.id]))
  const criticalIds = new Set(binding.checks.filter((check) => check.checkClass === 'CRITICAL').map((check) => check.id))
  const failedCritical =
    criticalIds.size === 0
      ? 0
      : (await tx.inspectionCheckResult.count({ where: { inspectionId: row.id, outcome: 'FAIL', planCheckId: { in: [...criticalIds] } } })) +
        (await tx.inspectionMeasurement.count({ where: { inspectionId: row.id, pass: false, planCheckId: { in: [...criticalIds] } } }))
  const rejected = sampleRejected({ counts, acceptMajor: row.acceptMajor, acceptMinor: row.acceptMinor, failedCritical })
  return { inspected, verdict: rejected ? ('reject' as const) : inspected >= row.sampleSize ? ('accept' as const) : ('open' as const) }
}

function emitRecorded(tools: CommandTools, row: InspectionRow, what: RecordedWhat, state: { inspected: number; verdict: 'open' | 'accept' | 'reject' }) {
  tools.emit({
    type: 'final_inspection.recorded',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { inspectionId: row.id, workOrderId: row.workOrderId, what, inspected: state.inspected, sampleSize: row.sampleSize, verdict: state.verdict },
  })
}

async function bump(tx: CommandTx, context: Inspector, row: InspectionRow, now: Date, data: Record<string, unknown> = {}) {
  await tx.inspection.update({ where: { id: row.id }, data: { ...data, ...takeOver(context, row), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
}

// ---- results ------------------------------------------------------------------------------------------------------------------

export interface ResultsBody {
  readonly version: number
  readonly results: readonly ResultInput[]
}

export async function recordResults(caller: CommandCaller, inspectionId: string, body: ResultsBody, idempotencyKey: string | undefined) {
  const { context, inspection, binding } = await recordable(caller, inspectionId)
  const problems = resultProblems(body.results, binding.checks, { sampleSize: inspection.sampleSize })
  if (problems.length > 0) throw invalid(problems.length === 1 ? problems[0]!.message : 'The results are not valid.', problems)
  const recorder = recorderOf(context)
  await command(caller, { name: 'quality.inspection.results', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockInspection(tx, inspection.id, body.version)
    const byCode = new Map(binding.checks.map((check) => [check.code, check]))
    const before = await tx.inspectionCheckResult.findMany({ where: { inspectionId: row.id }, select: RESULT_COLUMNS })
    const changes: unknown[] = []
    for (const input of body.results) {
      const check = byCode.get(input.checkCode)!
      const sampleIndex = input.sampleIndex ?? 1
      const existing = before.find((result) => result.planCheckId === check.id && result.sampleIndex === sampleIndex)
      if (input.outcome === null) {
        if (existing) await tx.inspectionCheckResult.delete({ where: { id: existing.id }, select: { id: true } })
        changes.push({ check: check.code, sampleIndex, outcome: null })
        continue
      }
      const value = input.outcome === 'NOT_APPLICABLE' ? null : input.value?.trim() || null
      const note = input.note?.trim() || null
      const data = { outcome: input.outcome, value, note, ...recorder, recordedAt: now }
      if (existing) await tx.inspectionCheckResult.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else await tx.inspectionCheckResult.create({ data: { id: newId(), siteId: row.siteId, inspectionId: row.id, planCheckId: check.id, sampleIndex, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      changes.push({ check: check.code, sampleIndex, outcome: input.outcome, value, note })
    }
    await bump(tx, context, row, now)
    tools.audit({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { results: before.length }, after: { results: changes } })
    emitRecorded(tools, row, 'RESULTS', await stateAfter(tx, row, inspectedNow(row), binding))
    return { id: row.id }
  })
  return sheetOf(caller, inspection.id)
}

// ---- measurements -------------------------------------------------------------------------------------------------------------

export interface MeasurementsBody {
  readonly version: number
  readonly measurements: readonly MeasurementInput[]
}

export async function recordMeasurements(caller: CommandCaller, inspectionId: string, body: MeasurementsBody, idempotencyKey: string | undefined) {
  const { context, inspection, header, binding } = await recordable(caller, inspectionId)
  // The rider's profile and template (QHS-053) and the sizes: read before the command (a floor device reads no party data;
  // a released work order's cells and a profile revision never change).
  const mtm = await factsReader(caller).withClient((client) => mtmFacts(client, header))
  const sizes = (await caller.withClient((client) => readCells(client, header.id))).map((cell) => cell.size)
  const { rows, problems } = resolveMeasurements(body.measurements, { checks: binding.checks, sampleSize: inspection.sampleSize, sizes, mtm: mtm ? { size: mtm.size, points: mtm.points } : null })
  if (problems.length > 0) throw invalid(problems.length === 1 ? problems[0]!.message : 'The measurements are not valid.', problems)
  const recorder = recorderOf(context)
  await command(caller, { name: 'quality.inspection.measurements', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockInspection(tx, inspection.id, body.version)
    const before = await measurementsOf(tx, row.id)
    const changes: unknown[] = []
    for (const input of rows) {
      const existing = before.find((value) => value.pointCode === input.pointCode && value.size === input.size && value.sampleIndex === input.sampleIndex)
      if (input.value === null) {
        if (existing) await tx.inspectionMeasurement.delete({ where: { id: existing.id }, select: { id: true } })
        changes.push({ point: input.pointCode, size: input.size, sampleIndex: input.sampleIndex, measured: null })
        continue
      }
      const data = { nominal: input.value.nominal, tolerance: input.value.tolerance, measured: input.value.measured, uom: input.value.uom, ...recorder, recordedAt: now }
      // The point, size, unit and check of a value never change (the guard): another check or point code is a new row.
      if (existing && existing.planCheckId === input.planCheckId) {
        await tx.inspectionMeasurement.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      } else {
        if (existing) await tx.inspectionMeasurement.delete({ where: { id: existing.id }, select: { id: true } })
        await tx.inspectionMeasurement.create({ data: { id: newId(), siteId: row.siteId, inspectionId: row.id, planCheckId: input.planCheckId, pointCode: input.pointCode, size: input.size, sampleIndex: input.sampleIndex, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      }
      changes.push({ point: input.pointCode, size: input.size, sampleIndex: input.sampleIndex, measured: input.value.measured, nominal: input.value.nominal, tolerance: input.value.tolerance, uom: input.value.uom, against: input.value.source })
    }
    await bump(tx, context, row, now)
    tools.audit({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { measurements: before.length }, after: { measurements: changes, ...(mtm ? { profileRevision: mtm.profile.revision } : {}) } })
    emitRecorded(tools, row, 'MEASUREMENTS', await stateAfter(tx, row, inspectedNow(row), binding))
    return { id: row.id }
  })
  return sheetOf(caller, inspection.id)
}

// ---- the counter ----------------------------------------------------------------------------------------------------------------

export interface CountBody {
  readonly version: number
  /** The units inspected (the counter's value), or `add` units to it (the "+ one piece": 1). */
  readonly inspected?: number | undefined
  readonly add?: number | undefined
}

/**
 * B-W2b-213: the count is Inspection.inspectedCount (the database keeps it 0..sample and freezes the AQL profile once it
 * is above 0). An inspection counted before the column keeps its count in the AQL_SAMPLE entry of `checklist`: this write
 * copies it into the column once (the count goes on from it) and drops the entry.
 */
export async function setCount(caller: CommandCaller, inspectionId: string, body: CountBody, idempotencyKey: string | undefined) {
  const { context, inspection, binding } = await recordable(caller, inspectionId)
  if ((body.inspected === undefined) === (body.add === undefined)) throw invalid('Give the units inspected, or how many to add.', [{ path: 'inspected', message: 'Give `inspected` (the count) or `add` (units to add), one of the two.' }])
  await command(caller, { name: 'quality.inspection.count', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockInspection(tx, inspection.id, body.version)
    const was = inspectedNow(row)
    const inspected = body.inspected ?? was + (body.add ?? 0)
    const problem = countProblem(inspected, row.sampleSize)
    if (problem) throw invalid(problem.message, [problem])
    const copied = row.inspectedCount === null && keepsSampleEntry(row.checklist)
    await bump(tx, context, row, now, { inspectedCount: inspected, ...(copied ? { checklist: withoutEntry(row.checklist, SAMPLE_ENTRY) } : {}) })
    tools.audit({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { inspected: was }, after: { inspected, ...(copied ? { copiedFrom: SAMPLE_ENTRY } : {}) } })
    emitRecorded(tools, row, 'COUNT', await stateAfter(tx, row, inspected, binding))
    return { id: row.id }
  })
  return sheetOf(caller, inspection.id)
}

// ---- the serial or batch check ---------------------------------------------------------------------------------------------------

export interface IdentityBody extends IdentityChange {
  readonly version: number
}

export async function changeIdentity(caller: CommandCaller, inspectionId: string, body: IdentityBody, idempotencyKey: string | undefined) {
  const { context, inspection, header, binding } = await recordable(caller, inspectionId)
  if ((body.add?.length ?? 0) + (body.remove?.length ?? 0) === 0) throw invalid('Scan a number, tick a garment without one, or take a scan back.', [{ path: 'add', message: 'Nothing to record.' }])
  await command(caller, { name: 'quality.inspection.identity', idempotencyKey, input: { inspectionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockInspection(tx, inspection.id, body.version)
    const facts = await identityFacts(tx, header, row)
    const changed = changeScans(facts.scans, body, { at: now.toISOString(), by: context.audience === 'floor' ? 'FLOOR' : 'OFFICE' })
    if (changed.problems.length > 0) throw invalid(changed.problems.length === 1 ? changed.problems[0]!.message : 'The scans are not valid.', changed.problems)
    const summary = identitySummary({ mode: facts.mode, expected: facts.expected.map((serial) => serial.serial), batchNumber: header.batchNumber, lotSize: row.lotSize, scans: changed.scans })
    await bump(tx, context, row, now, { checklist: withEntry(row.checklist, identityEntry(facts.mode, changed.scans, summary)) })
    tools.audit({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { identity: facts.summary.words }, after: { identity: summary.words, added: body.add ?? [], removed: body.remove ?? [], duplicates: changed.duplicates } })
    emitRecorded(tools, row, 'IDENTITY', await stateAfter(tx, row, inspectedNow(row), binding))
    return { id: row.id }
  })
  return sheetOf(caller, inspection.id)
}

// ---- photos of a result (QHS-054) ---------------------------------------------------------------------------------------------

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The tenant's system caller with files.upload and files.manage over this inspection's company and site only. */
function siteUploader(request: FastifyRequest, tenantId: string, row: Pick<InspectionRow, 'companyId' | 'siteId'>): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [row.companyId], sites: [row.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/**
 * The result a photo goes on: of an OPEN inspection on a plan, recorded by its inspector. The office also needs files.upload
 * over the company; a bench (whose role writes no files) uploads through the tenant's system caller holding exactly
 * files.upload and files.manage over the inspection's company and site: the photo is the office's and the site's floor files.
 */
async function photoTarget(request: FastifyRequest, inspectionId: string, resultId: string) {
  const { context, inspection } = await recordable(request, inspectionId)
  const result = isUuid(resultId) ? await request.withClient((client) => client.inspectionCheckResult.findFirst({ where: { id: resultId, inspectionId: inspection.id }, select: { id: true, sampleIndex: true } })) : null
  if (!result) throw new NotFoundError('Result not found.')
  if (context.audience === 'floor') return { inspection, result, uploader: siteUploader(request, context.tenantId, inspection), floor: true }
  if (!can(actorOf(context), FILES_UPLOAD, { companyId: inspection.companyId, siteId: inspection.siteId })) throw new ForbiddenError(`Adding a photo needs ${FILES_UPLOAD} over the company.`)
  return { inspection, result, uploader: request as CommandCaller, floor: false }
}

/** POST /quality/inspections/:inspectionId/results/:resultId/photos: the photo announced, then the presigned PUT. */
export async function announceResultPhoto(request: FastifyRequest, inspectionId: string, resultId: string, body: PhotoUpload, idempotencyKey?: string) {
  const { inspection, result, uploader, floor } = await photoTarget(request, inspectionId, resultId)
  const held = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: RESULT_RECORD, recordId: result.id, kind: 'PHOTO', status: { not: 'DELETED' } } }))
  if (held >= PLAN_LIMITS.photosPerResult) throw new InvalidStateError(`This result holds ${PLAN_LIMITS.photosPerResult} photos already.`)
  return requestUpload(
    processFiles(),
    uploader,
    {
      companyId: inspection.companyId,
      recordType: RESULT_RECORD,
      recordId: result.id,
      kind: 'PHOTO',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      ...(floor ? { visibility: ['OFFICE', 'FLOOR'] as const, floorSiteId: inspection.siteId } : {}),
    },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /quality/inspections/:inspectionId/results/:resultId/photos/:fileId/complete: the photo stored, the bench told. */
export async function completeResultPhoto(request: FastifyRequest, inspectionId: string, resultId: string, fileId: string, idempotencyKey?: string) {
  const { inspection, result, uploader } = await photoTarget(request, inspectionId, resultId)
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: RESULT_RECORD, recordId: result.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('Photo not found.')
  const stored = await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true })
  // The live message for the office's photo set and another bench (one command on the inspection: no version is asked of a
  // photo, so the row is locked as it stands; a key derived from the completion's makes a resend the same command).
  const context = inspectorOf(request)
  const binding = await request.withClient((client) => bindingOf(client, inspection))
  await command(request, { name: 'quality.inspection.photo', idempotencyKey: idempotencyKey ? `${idempotencyKey}.recorded` : undefined, input: { inspectionId, resultId, fileId } }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT "id" FROM "Inspection" WHERE "id" = ${inspection.id}::uuid FOR UPDATE`
    const row = (await tx.inspection.findUnique({ where: { id: inspection.id }, select: { id: true, status: true, checklist: true, inspectedCount: true } }))!
    tools.audit({ recordType: 'Inspection', recordId: inspection.id, companyId: inspection.companyId, siteId: inspection.siteId, after: { photo: fileId, result: result.id, sampleIndex: result.sampleIndex, status: stored.status, by: context.audience === 'floor' ? 'FLOOR' : 'OFFICE' } })
    if (row.status === 'OPEN') emitRecorded(tools, inspection, 'PHOTO', await stateAfter(tx, inspection, inspectedNow(row), binding))
    return { id: inspection.id }
  })
  return { file: stored }
}
