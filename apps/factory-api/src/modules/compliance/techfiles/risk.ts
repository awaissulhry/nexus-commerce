import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { TECHFILES_MANAGE, TECHFILES_SIGN, TECHFILES_VIEW } from '@nexus/factory-domain/compliance/techfiles/permissions'
import { RISK_ROWS_MAX, riskRowProblems, signProblems, type AssessmentStatus, type Hazard, type ResidualRisk, type RiskRowInput } from '@nexus/factory-domain/compliance/techfiles/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMay, guarded, mayOn, namesFor, officeOf, settings, techfilesClock, type Reader } from './common'
import { reopenInCommand } from './files'
import { FILE_SELECT, NOT_FOUND, readFile, type FileRow } from './store'

/**
 * The product risk assessment of a technical file (B-W2b-251; PRD-301; design compliance.techfiles › Risk assessment; PPE Reg.
 * Annex III (b); for a line that is not PPE, the GPSR risk analysis): revisions 1, 2, 3 … per file; a DRAFT with its hazards
 * (hazard, garment zone, intended use, foreseeable misuse, control, standard clause, residual risk), autosaved per row; SIGNED
 * by a person with their typed name and function and a fresh code (step-up), which supersedes the revision signed before and
 * points the file's (b) item at the new one (a complete file goes back to OPEN: its evidence changed). A draft nobody wants is
 * removed; a signed one is kept.
 *
 *   GET    /compliance/techfiles/:fileId/risk                                certificates.view
 *   POST   /compliance/techfiles/:fileId/risk                                techfiles.manage: the next revision, a DRAFT (copying the newest one's hazards)
 *   PATCH  /compliance/techfiles/:fileId/risk/:assessmentId                  techfiles.manage: class reasoning, note (DRAFT)
 *   DELETE /compliance/techfiles/:fileId/risk/:assessmentId?version=         techfiles.manage: a DRAFT with its rows
 *   POST   /compliance/techfiles/:fileId/risk/:assessmentId/rows             techfiles.manage: a hazard (DRAFT)
 *   PATCH  /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId      techfiles.manage
 *   DELETE /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId?version=
 *   POST   /compliance/techfiles/:fileId/risk/:assessmentId/sign             techfiles.sign + step-up
 */

const ASSESSMENT_SELECT = {
  id: true,
  technicalFileId: true,
  revision: true,
  status: true,
  classReasoning: true,
  signedAt: true,
  signedById: true,
  signedByName: true,
  signedByFunction: true,
  supersededAt: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ProductRiskAssessmentSelect
type AssessmentRow = Prisma.ProductRiskAssessmentGetPayload<{ select: typeof ASSESSMENT_SELECT }>

const ROW_SELECT = {
  id: true,
  assessmentId: true,
  seq: true,
  hazard: true,
  hazardNote: true,
  garmentZone: true,
  intendedUse: true,
  foreseeableMisuse: true,
  control: true,
  standardClause: true,
  standardId: true,
  residualRisk: true,
  note: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProductRiskRowSelect
type RiskRow = Prisma.ProductRiskRowGetPayload<{ select: typeof ROW_SELECT }>

const rowView = (row: RiskRow) => ({
  id: row.id,
  seq: row.seq,
  hazard: row.hazard as Hazard,
  hazardNote: row.hazardNote,
  garmentZone: row.garmentZone,
  intendedUse: row.intendedUse,
  foreseeableMisuse: row.foreseeableMisuse,
  control: row.control,
  standardClause: row.standardClause,
  standardId: row.standardId,
  residualRisk: row.residualRisk as ResidualRisk,
  note: row.note,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

async function assessmentsOf(db: Reader, file: FileRow, actor: ReturnType<typeof actorOf>) {
  const rows = await db.productRiskAssessment.findMany({ where: { technicalFileId: file.id }, select: ASSESSMENT_SELECT, orderBy: [{ revision: 'desc' }] })
  const riskRows = await db.productRiskRow.findMany({ where: { assessmentId: { in: rows.map((row) => row.id) } }, select: ROW_SELECT, orderBy: [{ seq: 'asc' }] })
  const names = await namesFor(db, rows.flatMap((row) => [row.signedById, row.createdById]))
  return {
    technicalFileId: file.id,
    fileStatus: file.status,
    assessments: rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      status: row.status as AssessmentStatus,
      classReasoning: row.classReasoning,
      note: row.note,
      signedAt: row.signedAt ? toUtcIso(row.signedAt) : null,
      signedBy: names(row.signedById),
      signedByName: row.signedByName,
      signedByFunction: row.signedByFunction,
      supersededAt: row.supersededAt ? toUtcIso(row.supersededAt) : null,
      createdBy: names(row.createdById),
      rows: riskRows.filter((entry) => entry.assessmentId === row.id).map(rowView),
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    })),
    may: { manage: mayOn(actor, TECHFILES_MANAGE, file.companyId), sign: mayOn(actor, TECHFILES_SIGN, file.companyId) },
    asOf: toUtcIso(techfilesClock().now()),
  }
}
export type RiskAnswer = Awaited<ReturnType<typeof assessmentsOf>>

/** GET /compliance/techfiles/:fileId/risk */
export async function getRisk(request: FastifyRequest, fileId: string): Promise<RiskAnswer> {
  const actor = actorOf(officeOf(request))
  return request.withClient(async (db) => assessmentsOf(db, await readFile(db, actor, fileId), actor))
}

const answerOf = (caller: CommandCaller, fileId: string): Promise<RiskAnswer> => {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => assessmentsOf(db, await readFile(db, actor, fileId), actor))
}

const riskEvent = (tools: Pick<CommandTools, 'emit'>, file: FileRow, assessment: { id: string; revision: number; status: string | null }, change: 'CREATED' | 'EDITED' | 'ROWS' | 'SIGNED' | 'REMOVED') =>
  tools.emit({ type: 'technical_file.risk_changed', subject: file.id, companyId: file.companyId, payload: { technicalFileId: file.id, assessmentId: assessment.id, revision: assessment.revision, status: assessment.status as AssessmentStatus | null, change } })

/** The file (its right checked) and the assessment of it, read inside the command. */
async function fileAndAssessment(tx: CommandTx, context: OfficeContext, fileId: string, assessmentId: string | null, permission: Permission = TECHFILES_MANAGE): Promise<{ file: FileRow; assessment: AssessmentRow | null }> {
  const file = await tx.technicalFile.findUnique({ where: { id: fileId }, select: FILE_SELECT })
  if (!file || !can(actorOf(context), TECHFILES_VIEW, { companyId: file.companyId })) throw new NotFoundError(NOT_FOUND)
  assertMay(context, permission, file.companyId, permission === TECHFILES_SIGN ? 'Signing a risk assessment' : 'Keeping a risk assessment')
  if (assessmentId === null) return { file, assessment: null }
  const assessment = await tx.productRiskAssessment.findUnique({ where: { id: assessmentId }, select: ASSESSMENT_SELECT })
  if (!assessment || assessment.technicalFileId !== fileId) throw new NotFoundError('Risk assessment not found.')
  return { file, assessment }
}

const draftOnly = (assessment: AssessmentRow) => new ConflictError(`Risk assessment revision ${assessment.revision} is ${assessment.status}: it changes no more (a change is the next revision).`)

export interface NewRevisionBody {
  readonly classReasoning?: string | null | undefined
  readonly note?: string | null | undefined
  /** Start from the newest revision's hazards (default) or from none. */
  readonly copyRows?: boolean | undefined
}

/** POST /compliance/techfiles/:fileId/risk */
export async function newRevision(caller: CommandCaller, fileId: string, body: NewRevisionBody, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.newRisk', idempotencyKey: key, input: { fileId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        await tx.$queryRaw`SELECT id FROM "TechnicalFile" WHERE id = ${fileId}::uuid FOR UPDATE`
        const { file } = await fileAndAssessment(tx, context, fileId, null)
        if (file.status === 'ARCHIVED') throw new ConflictError(`Technical file ${file.number} is archived: its risk assessment is kept as it is.`)
        const existing = await tx.productRiskAssessment.findMany({ where: { technicalFileId: fileId }, select: { id: true, revision: true, status: true, classReasoning: true }, orderBy: [{ revision: 'desc' }] })
        const draft = existing.find((row) => row.status === 'DRAFT')
        if (draft) throw new ConflictError(`Revision ${draft.revision} is a draft already: edit that one.`)
        const newest = existing[0] ?? null
        const id = newId()
        const revision = (newest?.revision ?? 0) + 1
        const row = await tx.productRiskAssessment.create({
          data: { id, technicalFileId: fileId, revision, classReasoning: body.classReasoning !== undefined ? body.classReasoning : (newest?.classReasoning ?? null), note: body.note ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: ASSESSMENT_SELECT,
        })
        let copied = 0
        if (newest && body.copyRows !== false) {
          const rows = await tx.productRiskRow.findMany({ where: { assessmentId: newest.id }, select: ROW_SELECT, orderBy: [{ seq: 'asc' }] })
          if (rows.length > 0) {
            await tx.productRiskRow.createMany({
              data: rows.map((entry) => ({ id: newId(), assessmentId: id, seq: entry.seq, hazard: entry.hazard, hazardNote: entry.hazardNote, garmentZone: entry.garmentZone, intendedUse: entry.intendedUse, foreseeableMisuse: entry.foreseeableMisuse, control: entry.control, standardClause: entry.standardClause, standardId: entry.standardId, residualRisk: entry.residualRisk, note: entry.note, createdAt: now, updatedAt: now, createdById: context.actorId })),
            })
            copied = rows.length
          }
        }
        audit({ recordType: 'ProductRiskAssessment', recordId: id, companyId: file.companyId, after: { technicalFileId: fileId, revision, status: 'DRAFT', copiedRows: copied, fromRevision: newest?.revision ?? null } })
        riskEvent(tools, file, row, 'CREATED')
        return { id }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** PATCH /compliance/techfiles/:fileId/risk/:assessmentId {version, classReasoning?, note?} */
export async function editRevision(caller: CommandCaller, fileId: string, assessmentId: string, body: { readonly version: number; readonly classReasoning?: string | null | undefined; readonly note?: string | null | undefined }, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.editRisk', idempotencyKey: key, input: { fileId, assessmentId, ...body }, record: { type: 'ProductRiskAssessment', id: assessmentId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId)
        if (assessment!.status !== 'DRAFT') throw draftOnly(assessment!)
        const row = await tx.productRiskAssessment.update({
          where: { id: assessmentId },
          data: { ...(body.classReasoning !== undefined ? { classReasoning: body.classReasoning } : {}), ...(body.note !== undefined ? { note: body.note } : {}), updatedAt: now },
          select: ASSESSMENT_SELECT,
        })
        audit({ recordType: 'ProductRiskAssessment', recordId: assessmentId, companyId: file.companyId, before: { classReasoning: assessment!.classReasoning, note: assessment!.note }, after: { classReasoning: row.classReasoning, note: row.note } })
        riskEvent(tools, file, row, 'EDITED')
        return { id: assessmentId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** DELETE /compliance/techfiles/:fileId/risk/:assessmentId?version= — a draft with its rows. */
export async function removeRevision(caller: CommandCaller, fileId: string, assessmentId: string, version: number, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.removeRisk', idempotencyKey: key, input: { fileId, assessmentId, version }, record: { type: 'ProductRiskAssessment', id: assessmentId, expectedVersion: version } },
      async (tools) => {
        const { tx, audit } = tools
        const { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId)
        if (assessment!.status !== 'DRAFT') throw new ConflictError(`Risk assessment revision ${assessment!.revision} is ${assessment!.status}: it is kept, never removed.`)
        const rows = await tx.productRiskRow.deleteMany({ where: { assessmentId } })
        await tx.productRiskAssessment.delete({ where: { id: assessmentId } })
        audit({ recordType: 'ProductRiskAssessment', recordId: assessmentId, companyId: file.companyId, before: { technicalFileId: fileId, revision: assessment!.revision, status: 'DRAFT', rows: rows.count } })
        riskEvent(tools, file, { id: assessmentId, revision: assessment!.revision, status: null }, 'REMOVED')
        return { id: assessmentId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

export interface RowBody extends RiskRowInput {
  readonly standardId?: string | null | undefined
}

async function checkStandard(tx: Reader, standardId: string | null | undefined): Promise<void> {
  if (!standardId) return
  if (!(await tx.regulationOrStandard.findUnique({ where: { id: standardId }, select: { id: true } }))) {
    throw new ValidationError('The standard is not in the register.', [{ path: 'body/standardId', message: 'Name an entry of the register of laws and standards (or only type the clause).' }])
  }
}

const rowData = (body: RowBody) => ({
  hazard: body.hazard as Hazard,
  hazardNote: body.hazardNote ?? null,
  garmentZone: body.garmentZone ?? null,
  intendedUse: body.intendedUse!,
  foreseeableMisuse: body.foreseeableMisuse ?? null,
  control: body.control!,
  standardClause: body.standardClause ?? null,
  standardId: body.standardId ?? null,
  residualRisk: body.residualRisk as ResidualRisk,
  note: body.note ?? null,
})

function checkRow(row: RiskRowInput): void {
  const problems = riskRowProblems(row)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The hazard row is not valid.', problems)
}

/** POST /compliance/techfiles/:fileId/risk/:assessmentId/rows */
export async function addRow(caller: CommandCaller, fileId: string, assessmentId: string, body: RowBody, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  checkRow(body)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.addRiskRow', idempotencyKey: key, input: { fileId, assessmentId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        await tx.$queryRaw`SELECT id FROM "ProductRiskAssessment" WHERE id = ${assessmentId}::uuid FOR UPDATE`
        const { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId)
        if (assessment!.status !== 'DRAFT') throw draftOnly(assessment!)
        await checkStandard(tx, body.standardId)
        const seqs = await tx.productRiskRow.findMany({ where: { assessmentId }, select: { seq: true } })
        if (seqs.length >= RISK_ROWS_MAX) throw new ConflictError(`A risk assessment holds at most ${RISK_ROWS_MAX} hazards.`)
        const id = newId()
        await tx.productRiskRow.create({ data: { id, assessmentId, seq: Math.max(0, ...seqs.map((row) => row.seq)) + 1, ...rowData(body), createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
        audit({ recordType: 'ProductRiskRow', recordId: id, companyId: file.companyId, after: { assessmentId, ...rowData(body) } })
        riskEvent(tools, file, assessment!, 'ROWS')
        return { id }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** PATCH /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId {version, …} (autosave per cell: the whole row as it stands after the change) */
export async function editRow(caller: CommandCaller, fileId: string, assessmentId: string, rowId: string, body: RowBody & { readonly version: number }, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.editRiskRow', idempotencyKey: key, input: { fileId, assessmentId, rowId, ...body }, record: { type: 'ProductRiskRow', id: rowId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId)
        const before = await tx.productRiskRow.findUnique({ where: { id: rowId }, select: ROW_SELECT })
        if (!before || before.assessmentId !== assessmentId) throw new NotFoundError('Hazard row not found.')
        if (assessment!.status !== 'DRAFT') throw draftOnly(assessment!)
        const merged: RowBody = {
          hazard: body.hazard ?? before.hazard,
          hazardNote: body.hazardNote !== undefined ? body.hazardNote : before.hazardNote,
          garmentZone: body.garmentZone !== undefined ? body.garmentZone : before.garmentZone,
          intendedUse: body.intendedUse ?? before.intendedUse,
          foreseeableMisuse: body.foreseeableMisuse !== undefined ? body.foreseeableMisuse : before.foreseeableMisuse,
          control: body.control ?? before.control,
          standardClause: body.standardClause !== undefined ? body.standardClause : before.standardClause,
          standardId: body.standardId !== undefined ? body.standardId : before.standardId,
          residualRisk: body.residualRisk ?? before.residualRisk,
          note: body.note !== undefined ? body.note : before.note,
        }
        checkRow(merged)
        await checkStandard(tx, body.standardId)
        await tx.productRiskRow.update({ where: { id: rowId }, data: { ...rowData(merged), updatedAt: now }, select: { id: true } })
        audit({ recordType: 'ProductRiskRow', recordId: rowId, companyId: file.companyId, before: rowData({ ...before, standardId: before.standardId }), after: rowData(merged) })
        riskEvent(tools, file, assessment!, 'ROWS')
        return { id: rowId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

/** DELETE /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId?version= */
export async function removeRow(caller: CommandCaller, fileId: string, assessmentId: string, rowId: string, version: number, key: string | null | undefined): Promise<RiskAnswer> {
  const context = officeOf(caller)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.removeRiskRow', idempotencyKey: key, input: { fileId, assessmentId, rowId, version }, record: { type: 'ProductRiskRow', id: rowId, expectedVersion: version } },
      async (tools) => {
        const { tx, audit } = tools
        const { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId)
        const before = await tx.productRiskRow.findUnique({ where: { id: rowId }, select: ROW_SELECT })
        if (!before || before.assessmentId !== assessmentId) throw new NotFoundError('Hazard row not found.')
        if (assessment!.status !== 'DRAFT') throw draftOnly(assessment!)
        await tx.productRiskRow.delete({ where: { id: rowId } })
        audit({ recordType: 'ProductRiskRow', recordId: rowId, companyId: file.companyId, before: { assessmentId, seq: before.seq, hazard: before.hazard } })
        riskEvent(tools, file, assessment!, 'ROWS')
        return { id: rowId }
      },
      settings(),
    ),
  )
  return answerOf(caller, fileId)
}

export interface SignBody {
  readonly version: number
  readonly name: string
  readonly function: string
}

/**
 * POST /compliance/techfiles/:fileId/risk/:assessmentId/sign: the signer's own act (techfiles.sign, a fresh code). In ONE
 * command: the revision signed before → SUPERSEDED, this draft → SIGNED; then the file's (b) evidence points at it (LINKED, to
 * be reviewed again) — a COMPLETE file goes back to OPEN first, since its evidence changed.
 */
export async function signRevision(caller: CommandCaller, fileId: string, assessmentId: string, body: SignBody, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | null | undefined }): Promise<RiskAnswer & { reopened: boolean }> {
  const context = officeOf(caller)
  // The right first (a 403 never asks for a code), then the fresh code.
  const peek = await caller.withClient((db) => db.technicalFile.findUnique({ where: { id: fileId }, select: { companyId: true } }))
  if (!peek || !can(actorOf(context), TECHFILES_VIEW, { companyId: peek.companyId })) throw new NotFoundError(NOT_FOUND)
  assertMay(context, TECHFILES_SIGN, peek.companyId, 'Signing a risk assessment')
  options.stepUp()
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.techfiles.signRisk', idempotencyKey: options.idempotencyKey, input: { fileId, assessmentId, ...body }, record: { type: 'ProductRiskAssessment', id: assessmentId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        await tx.$queryRaw`SELECT id FROM "TechnicalFile" WHERE id = ${fileId}::uuid FOR UPDATE`
        let { file, assessment } = await fileAndAssessment(tx, context, fileId, assessmentId, TECHFILES_SIGN)
        if (file.status === 'ARCHIVED') throw new ConflictError(`Technical file ${file.number} is archived: its risk assessment is kept as it is.`)
        const rows = await tx.productRiskRow.count({ where: { assessmentId } })
        const problems = signProblems({ status: assessment!.status, rows, name: body.name, function: body.function })
        if (problems.length > 0) throw new DomainError(problems.some((issue) => issue.path.startsWith('body/')) ? 'validation_failed' : 'conflict', problems[0]!.message, problems)
        const previous = await tx.productRiskAssessment.findFirst({ where: { technicalFileId: fileId, status: 'SIGNED' }, select: { id: true, revision: true } })
        if (previous) await tx.productRiskAssessment.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', supersededAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
        const signed = await tx.productRiskAssessment.update({ where: { id: assessmentId }, data: { status: 'SIGNED', signedAt: now, signedById: context.actorId, signedByName: body.name.trim(), signedByFunction: body.function.trim(), updatedAt: now }, select: ASSESSMENT_SELECT })
        audit({ recordType: 'ProductRiskAssessment', recordId: assessmentId, companyId: file.companyId, before: { status: 'DRAFT' }, after: { status: 'SIGNED', signedByName: signed.signedByName, signedByFunction: signed.signedByFunction, rows, supersedes: previous?.id ?? null } })
        if (previous) audit({ recordType: 'ProductRiskAssessment', recordId: previous.id, companyId: file.companyId, before: { status: 'SIGNED' }, after: { status: 'SUPERSEDED' }, reason: `Revision ${signed.revision} was signed.` })
        riskEvent(tools, file, signed, 'SIGNED')

        // Point (b) of the file follows the signed revision.
        let reopened = false
        if (file.status === 'COMPLETE') {
          file = await reopenInCommand(tools, file, `Risk assessment revision ${signed.revision} was signed: point (b) is reviewed again.`)
          reopened = true
        }
        const items = await tx.technicalFileItem.findMany({ where: { technicalFileId: fileId, point: 'B_RISK_ASSESSMENT' }, select: { id: true, seq: true, state: true, recordType: true, recordId: true }, orderBy: [{ seq: 'asc' }] })
        const target = items.find((item) => item.recordType === 'ProductRiskAssessment') ?? items.find((item) => item.state === 'MISSING') ?? null
        if (target) {
          if (target.recordId !== assessmentId) {
            await tx.technicalFileItem.update({ where: { id: target.id }, data: { recordType: 'ProductRiskAssessment', recordId: assessmentId, fileId: null, state: 'LINKED', reviewedAt: null, reviewedById: null, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
            audit({ action: 'compliance.techfiles.editItem', recordType: 'TechnicalFileItem', recordId: target.id, companyId: file.companyId, before: { state: target.state, recordType: target.recordType, recordId: target.recordId }, after: { state: 'LINKED', recordType: 'ProductRiskAssessment', recordId: assessmentId } })
            tools.emit({ type: 'technical_file.item_changed', subject: file.id, companyId: file.companyId, payload: { technicalFileId: file.id, itemId: target.id, point: 'B_RISK_ASSESSMENT', state: 'LINKED', change: 'LINKED' } })
          }
        } else {
          const id = newId()
          await tx.technicalFileItem.create({ data: { id, technicalFileId: fileId, point: 'B_RISK_ASSESSMENT', seq: Math.max(0, ...items.map((item) => item.seq)) + 1, state: 'LINKED', recordType: 'ProductRiskAssessment', recordId: assessmentId, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
          audit({ action: 'compliance.techfiles.addItem', recordType: 'TechnicalFileItem', recordId: id, companyId: file.companyId, after: { technicalFileId: fileId, point: 'B_RISK_ASSESSMENT', state: 'LINKED', recordType: 'ProductRiskAssessment', recordId: assessmentId } })
          tools.emit({ type: 'technical_file.item_changed', subject: file.id, companyId: file.companyId, payload: { technicalFileId: file.id, itemId: id, point: 'B_RISK_ASSESSMENT', state: 'LINKED', change: 'LINKED' } })
        }
        return { reopened }
      },
      settings(),
    ),
  )
  return { ...(await answerOf(caller, fileId)), reopened: result.reopened }
}
