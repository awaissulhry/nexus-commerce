import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { PURCHASING_QUALIFICATION_MANAGE } from '@nexus/factory-domain/purchasing/qualification/permissions'
import {
  daysProblem,
  decisionProblems,
  evidenceProblem,
  MOVE_REFUSALS,
  MOVES,
  planScope,
  qualificationFor,
  reasonOf,
  standingOf,
  wordsOf,
  type Decision,
  type Evidence,
  type Need,
  type QualificationFacts,
  type QualificationStatus,
  type Scope,
} from '@nexus/factory-domain/purchasing/qualification/rules'
import { events as qualificationEvents } from '@nexus/factory-domain/supplier-qualification/events'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, type Reader } from '../store'
import { peopleNames, readSupplier, type SupplierRow } from '../suppliers-depth/store'
import { questionnaireFilesOf, vaultFilesOf } from './store'

/**
 * Supplier and subcontractor qualification (B-W2b-315; SCM-027, PLN-162; follow-up VN2:02 "Subcontractor qualification reads
 * the accepted questionnaire and the documents it put in force"; design purchasing.suppliers › Documents & qualification ›
 * Workshop profile "what they can do and whether they are in order"):
 *
 *   GET   /purchasing/suppliers/:partyId/qualifications            its qualifications by company, each with its standing
 *                                                                  today (and why not), the evidence with each document's
 *                                                                  expiry, what may be done; the evidence it may rest on
 *                                                                  (accepted questionnaires and the documents they put in
 *                                                                  force, accepted uploads, its documents in force); per
 *                                                                  kind of work whether it is qualified now
 *   POST  …/qualifications                                         asked: PENDING (no evidence named: the newest accepted
 *                                                                  questionnaire of the company and the documents it put
 *                                                                  in force)
 *   PATCH …/qualifications/:id                                     scope, days, evidence while PENDING
 *   POST  …/qualifications/:id/decide | suspend | lift | withdraw  decided once; suspended with why; lifted back; withdrawn
 *
 * Reading parties.view; writing purchasing.qualification.manage, both over the qualification's company and the supplier.
 * `qualificationsFor` is planning's question (B-W2b-321 / -338: only qualified workshops are offered, the others with why).
 */

const changedEvent = qualificationEvents[5]

export const QUALIFICATION_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  workCentreKinds: true,
  operationIds: true,
  materialKinds: true,
  status: true,
  validFrom: true,
  validUntil: true,
  evidence: true,
  decidedAt: true,
  decidedById: true,
  conditions: true,
  refuseReason: true,
  suspendedAt: true,
  suspendReason: true,
  withdrawnAt: true,
  withdrawReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SupplierQualificationSelect
type QualificationRow = Prisma.SupplierQualificationGetPayload<{ select: typeof QUALIFICATION_COLUMNS }>

const evidenceOf = (value: unknown): Evidence[] => (Array.isArray(value) ? value.filter((entry): entry is Evidence => typeof entry === 'object' && entry !== null && typeof (entry as Evidence).recordType === 'string' && typeof (entry as Evidence).recordId === 'string') : [])
const scopeOf = (row: QualificationRow): Scope => ({ workCentreKinds: [...row.workCentreKinds] as WorkCentreKind[], operationIds: [...row.operationIds], materialKinds: [...row.materialKinds] as ItemKind[] })

/** The current version of a file's series (a renewed document replaces it): its last valid day. */
async function currentExpiryOf(db: Reader, fileIds: readonly string[]): Promise<Map<string, BusinessDate | null>> {
  const out = new Map<string, BusinessDate | null>()
  if (fileIds.length === 0) return out
  const files = await db.storedFile.findMany({ where: { id: { in: [...fileIds] } }, select: { id: true, seriesId: true, expiresOn: true } })
  const roots = [...new Set(files.map((file) => file.seriesId ?? file.id))]
  const current = await db.storedFile.findMany({ where: { OR: [{ id: { in: roots } }, { seriesId: { in: roots } }], status: 'AVAILABLE', supersededAt: null }, select: { id: true, seriesId: true, expiresOn: true } })
  for (const file of files) {
    const root = file.seriesId ?? file.id
    const now = current.find((row) => (row.seriesId ?? row.id) === root)
    out.set(file.id, now ? (now.expiresOn ? dayOf(now.expiresOn) : null) : file.expiresOn ? dayOf(file.expiresOn) : null)
  }
  return out
}

interface EvidenceDetail {
  readonly recordType: Evidence['recordType']
  readonly recordId: string
  readonly label: string
  /** The documents it rests on and their last valid day (a questionnaire's: the documents it put in force). */
  readonly documents: { readonly fileId: string; readonly expiresOn: BusinessDate | null }[]
}

/** Each evidence entry in words with its documents' expiry, for the party. */
async function evidenceDetails(db: Reader, partyId: string, evidence: readonly Evidence[]): Promise<EvidenceDetail[]> {
  const ids = (type: Evidence['recordType']) => evidence.filter((entry) => entry.recordType === type).map((entry) => entry.recordId)
  const responses = ids('SupplierQuestionnaireResponse').length === 0 ? [] : await db.supplierQuestionnaireResponse.findMany({ where: { id: { in: ids('SupplierQuestionnaireResponse') }, partyId }, select: { id: true, submittedAt: true, reviewedAt: true, decision: true } })
  const uploads = ids('SupplierDocumentUpload').length === 0 ? [] : await db.supplierDocumentUpload.findMany({ where: { id: { in: ids('SupplierDocumentUpload') }, partyId }, select: { id: true, category: true, issuer: true, documentNumber: true, documentFileId: true, status: true } })
  const files = ids('StoredFile').length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: ids('StoredFile') } }, select: { id: true, originalName: true, category: true } })
  const answered = await questionnaireFilesOf(db, partyId)
  const byResponse = new Map<string, string[]>()
  for (const [fileId, entry] of answered) byResponse.set(entry.responseId, [...(byResponse.get(entry.responseId) ?? []), fileId])
  const fileIds = [...ids('StoredFile'), ...uploads.flatMap((row) => (row.documentFileId ? [row.documentFileId] : [])), ...[...byResponse.values()].flat()]
  const expiry = await currentExpiryOf(db, fileIds)
  const docs = (list: readonly string[]) => list.map((fileId) => ({ fileId, expiresOn: expiry.get(fileId) ?? null }))
  return evidence.map((entry): EvidenceDetail => {
    if (entry.recordType === 'SupplierQuestionnaireResponse') {
      const row = responses.find((response) => response.id === entry.recordId)
      return { ...entry, label: row ? `Questionnaire answered ${toUtcIso(row.submittedAt).slice(0, 10)}${row.reviewedAt ? `, accepted ${toUtcIso(row.reviewedAt).slice(0, 10)}` : ''}` : 'Questionnaire', documents: docs(byResponse.get(entry.recordId) ?? []) }
    }
    if (entry.recordType === 'SupplierDocumentUpload') {
      const row = uploads.find((upload) => upload.id === entry.recordId)
      return { ...entry, label: row ? [row.category.toLowerCase().replace('_', ' '), row.issuer, row.documentNumber].filter(Boolean).join(' · ') : 'Document', documents: docs(row?.documentFileId ? [row.documentFileId] : []) }
    }
    const row = files.find((file) => file.id === entry.recordId)
    return { ...entry, label: row ? row.originalName : 'File', documents: docs([entry.recordId]) }
  })
}

/** The earliest last day among the documents a qualification rests on that has passed (null: none). */
const expiredOn = (details: readonly EvidenceDetail[], today: BusinessDate): BusinessDate | null =>
  details.flatMap((detail) => detail.documents.flatMap((doc) => (doc.expiresOn !== null && doc.expiresOn < today ? [doc.expiresOn] : []))).sort()[0] ?? null

function factsOf(row: QualificationRow, evidenceExpiredOn: BusinessDate | null): QualificationFacts {
  return {
    id: row.id,
    status: row.status as QualificationStatus,
    scope: scopeOf(row),
    validFrom: row.validFrom ? dayOf(row.validFrom) : null,
    validUntil: row.validUntil ? dayOf(row.validUntil) : null,
    conditions: row.conditions,
    suspendReason: row.suspendReason,
    refuseReason: row.refuseReason,
    evidenceExpiredOn,
  }
}

/** The evidence a qualification of the party may rest on: accepted questionnaires (with their documents), accepted uploads, its documents in force. */
async function suggestionsOf(db: Reader, partyId: string, companyIds: readonly string[]) {
  const responses = await db.supplierQuestionnaireResponse.findMany({ where: { partyId, decision: 'ACCEPTED', ...(companyIds.length > 0 ? { companyId: { in: [...companyIds] } } : {}) }, select: { id: true, companyId: true, submittedAt: true, reviewedAt: true }, orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }], take: 20 })
  const answered = await questionnaireFilesOf(db, partyId)
  const uploads = await db.supplierDocumentUpload.findMany({ where: { partyId, status: 'ACCEPTED' }, select: { id: true, companyId: true, category: true, issuer: true, documentNumber: true, acceptedExpiresOn: true }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: 50 })
  const files = await vaultFilesOf(db, partyId)
  return {
    questionnaires: responses.map((row) => ({ recordType: 'SupplierQuestionnaireResponse' as const, recordId: row.id, companyId: row.companyId, submittedAt: toUtcIso(row.submittedAt), reviewedAt: row.reviewedAt ? toUtcIso(row.reviewedAt) : null, documents: [...answered].filter(([, entry]) => entry.responseId === row.id).map(([fileId, entry]) => ({ fileId, key: entry.key })) })),
    uploads: uploads.map((row) => ({ recordType: 'SupplierDocumentUpload' as const, recordId: row.id, companyId: row.companyId, category: row.category, issuer: row.issuer, number: row.documentNumber, expiresOn: row.acceptedExpiresOn ? dayOf(row.acceptedExpiresOn) : null })),
    files: files.map((doc) => ({ recordType: 'StoredFile' as const, recordId: doc.fileId, category: doc.category, name: doc.name, expiresOn: doc.expiresOn })),
  }
}

/** GET /purchasing/suppliers/:partyId/qualifications. */
export async function listQualifications(caller: CommandCaller, partyId: string) {
  const supplier = await readSupplier(caller, partyId)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const rows = (await client.supplierQualification.findMany({ where: { partyId: supplier.id }, select: QUALIFICATION_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })).filter((row) => can(actor, PARTIES_VIEW, { companyId: row.companyId, partyId: supplier.id }))
    const operationIds = [...new Set(rows.flatMap((row) => row.operationIds))]
    const operations = operationIds.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true, code: true, name: true } })
    const names = await peopleNames(client, rows.map((row) => row.decidedById))
    const views = []
    const facts: QualificationFacts[] = []
    for (const row of rows) {
      const details = await evidenceDetails(client, supplier.id, evidenceOf(row.evidence))
      const fact = factsOf(row, expiredOn(details, today))
      facts.push(fact)
      const status = row.status as QualificationStatus
      const mayManage = can(actor, PURCHASING_QUALIFICATION_MANAGE, { companyId: row.companyId, partyId: supplier.id })
      views.push({
        id: row.id,
        companyId: row.companyId,
        status,
        scope: { workCentreKinds: [...fact.scope.workCentreKinds], materialKinds: [...fact.scope.materialKinds], operations: row.operationIds.map((id) => ({ id, code: operations.find((op) => op.id === id)?.code ?? null, name: operations.find((op) => op.id === id)?.name ?? null })) },
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        evidence: details.map((detail) => ({ ...detail, documents: detail.documents.map((doc) => ({ ...doc, expired: doc.expiresOn !== null && doc.expiresOn < today })) })),
        decided: row.decidedAt ? { at: toUtcIso(row.decidedAt), by: row.decidedById ? { id: row.decidedById, name: names.get(row.decidedById) ?? null } : null } : null,
        conditions: row.conditions,
        refuseReason: row.refuseReason,
        suspended: row.suspendedAt ? { at: toUtcIso(row.suspendedAt), reason: row.suspendReason } : null,
        withdrawn: row.withdrawnAt ? { at: toUtcIso(row.withdrawnAt), reason: row.withdrawReason } : null,
        standing: standingOf(fact, today),
        version: row.version,
        may: { change: mayManage && MOVES.change.includes(status), decide: mayManage && status === 'PENDING', suspend: mayManage && MOVES.suspend.includes(status), lift: mayManage && MOVES.lift.includes(status), withdraw: mayManage && MOVES.withdraw.includes(status) },
      })
    }
    const workKinds = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING'] as const
    const companies = [...new Set(rows.map((row) => row.companyId))]
    return {
      supplier: { id: supplier.id, code: supplier.code, name: supplier.tradeName ?? supplier.legalName, roles: [...supplier.roles], kinds: [...supplier.supplierKinds] },
      qualifications: views,
      /** Per company and kind of work, whether it is qualified now (the Workshop profile; planning asks the same). */
      work: supplier.roles.includes('SUBCONTRACTOR') ? companies.flatMap((companyId) => workKinds.map((kind) => ({ companyId, workCentreKind: kind, ...qualificationFor(facts.filter((_fact, index) => rows[index]!.companyId === companyId), { workCentreKind: kind }, today) }))) : [],
      suggestions: await suggestionsOf(client, supplier.id, companies),
      may: { create: can(actor, PURCHASING_QUALIFICATION_MANAGE, supplier.companyId ? { companyId: supplier.companyId, partyId: supplier.id } : { partyId: supplier.id }) },
    }
  })
}

/** Planning's question (PLN-162): for each party, whether it is qualified for the need in the company today, and why not. */
export async function qualificationsFor(db: Reader, input: { readonly companyId: string; readonly partyIds: readonly string[]; readonly need: Need; readonly today: BusinessDate }) {
  const out = new Map<string, ReturnType<typeof qualificationFor>>()
  const rows = input.partyIds.length === 0 ? [] : await db.supplierQualification.findMany({ where: { companyId: input.companyId, partyId: { in: [...input.partyIds] } }, select: QUALIFICATION_COLUMNS })
  for (const partyId of input.partyIds) {
    const facts: QualificationFacts[] = []
    for (const row of rows.filter((entry) => entry.partyId === partyId)) facts.push(factsOf(row, expiredOn(await evidenceDetails(db, partyId, evidenceOf(row.evidence)), input.today)))
    out.set(partyId, qualificationFor(facts, input.need, input.today))
  }
  return out
}

// ---- writes ---------------------------------------------------------------------------------------------------------

const refusal = (issues: readonly Issue[]): DomainError => new ValidationError(issues[0]!.message, [...issues])

function assertManage(caller: CommandCaller, supplier: SupplierRow, companyId: string): void {
  if (!can(actorOf(officeContextOf(caller)), PURCHASING_QUALIFICATION_MANAGE, { companyId, partyId: supplier.id })) throw new ForbiddenError('Qualifying a supplier needs purchasing.qualification.manage over its company.')
}

/** Every evidence entry is the party's and in force: an ACCEPTED questionnaire or upload, an AVAILABLE file of it (or of the qualification). */
async function checkEvidence(db: Reader, partyId: string, evidence: readonly Evidence[], qualificationId: string | null): Promise<void> {
  const problem = evidenceProblem(evidence)
  if (problem) throw refusal([problem])
  const missing: string[] = []
  for (const entry of evidence) {
    const found =
      entry.recordType === 'SupplierQuestionnaireResponse'
        ? await db.supplierQuestionnaireResponse.count({ where: { id: entry.recordId, partyId, decision: 'ACCEPTED' } })
        : entry.recordType === 'SupplierDocumentUpload'
          ? await db.supplierDocumentUpload.count({ where: { id: entry.recordId, partyId, status: 'ACCEPTED' } })
          : await db.storedFile.count({ where: { id: entry.recordId, status: 'AVAILABLE', OR: [{ recordType: 'Party', recordId: partyId }, ...(qualificationId ? [{ recordType: 'SupplierQualification', recordId: qualificationId }] : [])] } })
    if (found === 0) missing.push(`${entry.recordType} ${entry.recordId}`)
  }
  if (missing.length > 0) throw new ValidationError('Evidence is an accepted questionnaire or document of this supplier, or one of its files in force.', [{ path: 'body/evidence', message: `Not evidence of this supplier: ${missing.join(', ')}.` }])
}

/** VN2:02: with no evidence named, the newest accepted questionnaire of the company and the documents it put in force. */
async function defaultEvidence(db: Reader, partyId: string, companyId: string): Promise<Evidence[]> {
  const response = await db.supplierQuestionnaireResponse.findFirst({ where: { partyId, companyId, decision: 'ACCEPTED' }, select: { id: true }, orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }] })
  if (!response) return []
  const files = [...(await questionnaireFilesOf(db, partyId, companyId))].filter(([, entry]) => entry.responseId === response.id).map(([fileId]) => fileId)
  const inForce = files.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: files }, recordType: 'Party', recordId: partyId, status: 'AVAILABLE', supersededAt: null, category: { not: null } }, select: { id: true } })
  return [{ recordType: 'SupplierQuestionnaireResponse', recordId: response.id }, ...inForce.map((file): Evidence => ({ recordType: 'StoredFile', recordId: file.id }))]
}

async function assertOperations(db: Reader, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  if ((await db.operation.count({ where: { id: { in: [...ids] } } })) !== ids.length) throw new ValidationError('An operation is not one of the library.', [{ path: 'body/operationIds', message: 'Operations of the library.' }])
}

const emitChanged = (tools: CommandTools, row: { readonly id: string; readonly companyId: string; readonly partyId: string }, status: QualificationStatus, change: 'CREATED' | 'UPDATED' | 'DECIDED' | 'SUSPENDED' | 'LIFTED' | 'WITHDRAWN') =>
  tools.emit(eventFor(changedEvent, { subject: row.id, companyId: row.companyId, payload: { qualificationId: row.id, partyId: row.partyId, status, change } }))

export interface CreateBody {
  readonly companyId: string
  readonly workCentreKinds?: readonly WorkCentreKind[] | undefined
  readonly operationIds?: readonly string[] | undefined
  readonly materialKinds?: readonly ItemKind[] | undefined
  readonly validFrom?: BusinessDate | null | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly evidence?: readonly Evidence[] | undefined
}

/** POST /purchasing/suppliers/:partyId/qualifications: PENDING. */
export async function createQualification(caller: CommandCaller, partyId: string, body: CreateBody, idempotencyKey?: string) {
  const supplier = await readSupplier(caller, partyId)
  assertManage(caller, supplier, body.companyId)
  if (supplier.companyId !== null && supplier.companyId !== body.companyId) throw new ValidationError("The supplier is another company's: qualify it in its own company.", [{ path: 'body/companyId', message: "The supplier's company." }])
  const scope = planScope({ workCentreKinds: body.workCentreKinds ?? [], operationIds: body.operationIds ?? [], materialKinds: body.materialKinds ?? [] }, supplier.roles)
  if (!scope.ok) throw refusal(scope.issues)
  const days = daysProblem(body.validFrom ?? null, body.validUntil ?? null)
  if (days) throw refusal([days])
  const context = officeContextOf(caller)
  const id = newId()
  await command(caller, { name: 'purchasing.qualification.create', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    await assertOperations(tools.tx, scope.scope.operationIds)
    const evidence = body.evidence ? [...body.evidence] : await defaultEvidence(tools.tx, supplier.id, body.companyId)
    await checkEvidence(tools.tx, supplier.id, evidence, null)
    await tools.tx.supplierQualification.create({
      data: {
        id,
        companyId: body.companyId,
        partyId: supplier.id,
        workCentreKinds: [...scope.scope.workCentreKinds],
        operationIds: [...scope.scope.operationIds],
        materialKinds: [...scope.scope.materialKinds],
        validFrom: body.validFrom ? new Date(`${body.validFrom}T00:00:00.000Z`) : null,
        validUntil: body.validUntil ? new Date(`${body.validUntil}T00:00:00.000Z`) : null,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.qualification.create', recordType: 'SupplierQualification', recordId: id, companyId: body.companyId, after: { partyId: supplier.id, status: 'PENDING', scope: scope.scope, validFrom: body.validFrom ?? null, validUntil: body.validUntil ?? null, evidence } })
    emitChanged(tools, { id, companyId: body.companyId, partyId: supplier.id }, 'PENDING', 'CREATED')
  })
  return { ...(await listQualifications(caller, partyId)), qualificationId: id }
}

/** The qualification of this supplier as the caller read it (404 otherwise), with the manage permission over its company. */
async function seenQualification(caller: CommandCaller, partyId: string, qualificationId: string): Promise<{ supplier: SupplierRow; row: QualificationRow }> {
  if (!isUuid(qualificationId)) throw new NotFoundError('Qualification not found.')
  const supplier = await readSupplier(caller, partyId)
  const row = await caller.withClient((client) => client.supplierQualification.findUnique({ where: { id: qualificationId }, select: QUALIFICATION_COLUMNS }))
  if (!row || row.partyId !== supplier.id || !can(actorOf(officeContextOf(caller)), PARTIES_VIEW, { companyId: row.companyId, partyId: supplier.id })) throw new NotFoundError('Qualification not found.')
  assertManage(caller, supplier, row.companyId)
  return { supplier, row }
}

const moveRefusal = (words: string) => new DomainError('conflict', words, [{ path: 'status', message: words }])
const day = (value: BusinessDate | null | undefined): Date | null | undefined => (value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00.000Z`))

export interface UpdateBody {
  readonly version: number
  readonly workCentreKinds?: readonly WorkCentreKind[] | undefined
  readonly operationIds?: readonly string[] | undefined
  readonly materialKinds?: readonly ItemKind[] | undefined
  readonly validFrom?: BusinessDate | null | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly evidence?: readonly Evidence[] | undefined
}

/** PATCH …/qualifications/:id: scope, days and evidence while PENDING. */
export async function updateQualification(caller: CommandCaller, partyId: string, qualificationId: string, body: UpdateBody, idempotencyKey?: string) {
  const { supplier, row } = await seenQualification(caller, partyId, qualificationId)
  if (!MOVES.change.includes(row.status as QualificationStatus)) throw moveRefusal(MOVE_REFUSALS.change)
  const current = scopeOf(row)
  const scope = planScope({ workCentreKinds: body.workCentreKinds ?? current.workCentreKinds, operationIds: body.operationIds ?? current.operationIds, materialKinds: body.materialKinds ?? current.materialKinds }, supplier.roles)
  if (!scope.ok) throw refusal(scope.issues)
  const validFrom = body.validFrom !== undefined ? body.validFrom : row.validFrom ? dayOf(row.validFrom) : null
  const validUntil = body.validUntil !== undefined ? body.validUntil : row.validUntil ? dayOf(row.validUntil) : null
  const days = daysProblem(validFrom, validUntil)
  if (days) throw refusal([days])
  await command(caller, { name: 'purchasing.qualification.update', idempotencyKey, input: { partyId, qualificationId, ...body }, record: { type: 'SupplierQualification', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await assertOperations(tools.tx, scope.scope.operationIds)
    if (body.evidence) await checkEvidence(tools.tx, supplier.id, body.evidence, row.id)
    await tools.tx.supplierQualification.update({
      where: { id: row.id },
      data: { workCentreKinds: [...scope.scope.workCentreKinds], operationIds: [...scope.scope.operationIds], materialKinds: [...scope.scope.materialKinds], validFrom: day(validFrom), validUntil: day(validUntil), ...(body.evidence ? { evidence: [...body.evidence] as unknown as Prisma.InputJsonValue } : {}), updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.qualification.update', recordType: 'SupplierQualification', recordId: row.id, companyId: row.companyId, before: { scope: current, evidence: evidenceOf(row.evidence) }, after: { scope: scope.scope, validFrom, validUntil, evidence: body.evidence ?? evidenceOf(row.evidence) } })
    emitChanged(tools, row, 'PENDING', 'UPDATED')
  })
  return listQualifications(caller, partyId)
}

export interface DecideBody {
  readonly version: number
  readonly decision: Decision
  readonly conditions?: string | null | undefined
  readonly refuseReason?: string | null | undefined
  /** The first day it holds (default: today for a yes); the last day, when it ends. */
  readonly validFrom?: BusinessDate | null | undefined
  readonly validUntil?: BusinessDate | null | undefined
}

/** POST …/qualifications/:id/decide: once — APPROVED, CONDITIONAL (with its conditions) or REFUSED (with why). */
export async function decideQualification(caller: CommandCaller, partyId: string, qualificationId: string, body: DecideBody, idempotencyKey?: string) {
  const { row } = await seenQualification(caller, partyId, qualificationId)
  const context = officeContextOf(caller)
  const today = businessDate(serverClock.now())
  const validFrom = body.validFrom !== undefined ? body.validFrom : row.validFrom ? dayOf(row.validFrom) : body.decision === 'REFUSED' ? null : today
  const validUntil = body.validUntil !== undefined ? body.validUntil : row.validUntil ? dayOf(row.validUntil) : null
  const conditions = body.decision === 'CONDITIONAL' ? wordsOf(body.conditions) : null
  const refuseReason = body.decision === 'REFUSED' ? wordsOf(body.refuseReason) : null
  const problems = [...decisionProblems({ status: row.status as QualificationStatus, decision: body.decision, validFrom, evidence: evidenceOf(row.evidence), conditions, refuseReason }), ...(daysProblem(validFrom, validUntil) ? [daysProblem(validFrom, validUntil)!] : [])]
  if (problems.length > 0) throw problems[0]!.path === 'status' ? moveRefusal(problems[0]!.message) : refusal(problems)
  await command(caller, { name: 'purchasing.qualification.decide', idempotencyKey, input: { partyId, qualificationId, ...body }, record: { type: 'SupplierQualification', id: row.id, expectedVersion: body.version } }, async (tools) => {
    // The days while it is still PENDING, then the decision (the guard fixes them once decided).
    await tools.tx.supplierQualification.update({ where: { id: row.id }, data: { validFrom: day(validFrom), validUntil: day(validUntil), updatedAt: tools.now }, select: { id: true } })
    await tools.tx.supplierQualification.update({ where: { id: row.id }, data: { status: body.decision, decidedAt: tools.now, decidedById: context.actorId, conditions, refuseReason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.qualification.decide', recordType: 'SupplierQualification', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: body.decision, validFrom, validUntil, conditions, refuseReason } })
    emitChanged(tools, row, body.decision, 'DECIDED')
  })
  return listQualifications(caller, partyId)
}

/** POST …/qualifications/:id/suspend {version, reason}: an approved one held for a while, with why. */
export async function suspendQualification(caller: CommandCaller, partyId: string, qualificationId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { row } = await seenQualification(caller, partyId, qualificationId)
  if (!MOVES.suspend.includes(row.status as QualificationStatus)) throw moveRefusal(MOVE_REFUSALS.suspend)
  const reason = reasonOf(body.reason, 'Why it is suspended')
  if ('issue' in reason) throw refusal([reason.issue])
  await command(caller, { name: 'purchasing.qualification.suspend', idempotencyKey, input: { partyId, qualificationId, ...body }, record: { type: 'SupplierQualification', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.supplierQualification.update({ where: { id: row.id }, data: { status: 'SUSPENDED', suspendedAt: tools.now, suspendReason: reason.reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.qualification.suspend', recordType: 'SupplierQualification', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'SUSPENDED', reason: reason.reason } })
    emitChanged(tools, row, 'SUSPENDED', 'SUSPENDED')
  })
  return listQualifications(caller, partyId)
}

/** POST …/qualifications/:id/lift {version}: back to its decision (CONDITIONAL when it has conditions). */
export async function liftQualification(caller: CommandCaller, partyId: string, qualificationId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { row } = await seenQualification(caller, partyId, qualificationId)
  if (!MOVES.lift.includes(row.status as QualificationStatus)) throw moveRefusal(MOVE_REFUSALS.lift)
  const back = row.conditions ? 'CONDITIONAL' : 'APPROVED'
  await command(caller, { name: 'purchasing.qualification.lift', idempotencyKey, input: { partyId, qualificationId, ...body }, record: { type: 'SupplierQualification', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.supplierQualification.update({ where: { id: row.id }, data: { status: back, suspendedAt: null, suspendReason: null, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.qualification.lift', recordType: 'SupplierQualification', recordId: row.id, companyId: row.companyId, before: { status: 'SUSPENDED', reason: row.suspendReason }, after: { status: back } })
    emitChanged(tools, row, back, 'LIFTED')
  })
  return listQualifications(caller, partyId)
}

/** POST …/qualifications/:id/withdraw {version, reason}: ended for good, with why. */
export async function withdrawQualification(caller: CommandCaller, partyId: string, qualificationId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { row } = await seenQualification(caller, partyId, qualificationId)
  if (!MOVES.withdraw.includes(row.status as QualificationStatus)) throw moveRefusal(MOVE_REFUSALS.withdraw)
  const reason = reasonOf(body.reason, 'Why it is withdrawn')
  if ('issue' in reason) throw refusal([reason.issue])
  await command(caller, { name: 'purchasing.qualification.withdraw', idempotencyKey, input: { partyId, qualificationId, ...body }, record: { type: 'SupplierQualification', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.supplierQualification.update({ where: { id: row.id }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawReason: reason.reason, suspendedAt: null, suspendReason: null, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.qualification.withdraw', recordType: 'SupplierQualification', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'WITHDRAWN', reason: reason.reason } })
    emitChanged(tools, row, 'WITHDRAWN', 'WITHDRAWN')
  })
  return listQualifications(caller, partyId)
}
