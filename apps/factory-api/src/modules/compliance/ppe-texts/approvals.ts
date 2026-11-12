import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { PPE_TEXTS_MANAGE, PPE_TEXTS_VIEW } from '@nexus/factory-domain/compliance/ppe-texts/permissions'
import {
  GENERATOR_TEMPLATES,
  isLive,
  labelFitsApproval,
  normaliseCheckedBy,
  normaliseLanguages,
  recordProblems,
  templateIdOf,
  withdrawProblems,
  type PpeTextKind,
} from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { addYears } from '../../../platform/files/rules'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { mayWrite } from '../../product/materials/store'
import { namesFor, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import type { ApprovalView } from './contract'
import { APPROVAL_SELECT, factsOf, type ApprovalRow } from './store'

/**
 * The PPE text approvals (B-W2b-288, FU2:01; GATE-PPE-TEXTS, the Owner's answer to W2b-4 question 2: a PPE consultant checks
 * the generated texts once, per template; factory-db PpeTextApproval of B-W2b-275). Compliance › Rules & markets › Templates.
 *
 *   GET  /compliance/ppe-texts                         the templates that generate PPE texts (the DoC's, the user
 *                                                      information's, each PPE garment label's class warnings) with their
 *                                                      state, and every approval the reader's companies reach
 *   POST /compliance/ppe-texts/evidence                announce the consultant's file (a file of the approval to come:
 *                                                      platform/files/owned.ts) → the presigned PUT and the approval's id
 *   POST /compliance/ppe-texts                         record the yes: the file confirmed (files.completeUpload), a fresh
 *                                                      code (step-up), then ONE command inserts the approval in force (its
 *                                                      audit row, the event) and keeps the file ten years
 *   POST /compliance/ppe-texts/:approvalId/withdraw    withdraw it once with a reason (no code: it closes the gate again)
 *
 * The gate itself is the database's (the ComplianceDocument rule of …_followups_product_w2b4_guards): a generated DoC or leaflet
 * leaves draft only while an approval in force covers its template, language and company. Nothing here issues a text. The
 * generators read the approvals through ./store (their detail's `gate`; the label's class warnings). Recording and
 * withdrawing need compliance.ppeTexts.manage (the owner's) over the approval's company; an approval of every company needs
 * a grant over every company.
 */

/** The consultant's file is kept as long as the texts it approves may travel with the goods (art. 8(3): ten years). */
const EVIDENCE_YEARS = 10
const EVIDENCE_WHY = "Reg. (EU) 2016/425 art. 8(3): the PPE consultant's check of the generated texts is kept ten years with the declarations it opened."

const settings = () => ({ ...COMMAND_SETTINGS, clock: rulesClock() })
const refused = (code: string, message: string) => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** The rows a person may read: approvals of every company and of the companies the view reaches. */
const reach = (context: OfficeContext): Prisma.PpeTextApprovalWhereInput => scopeWhere(actorOf(context), PPE_TEXTS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.PpeTextApprovalWhereInput

function assertMayManage(context: OfficeContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), PPE_TEXTS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? "A PPE consultant's yes for every company is recorded only by a role over every company." : undefined)
  }
}

async function approvalViews(db: Reader, context: OfficeContext, rows: readonly ApprovalRow[]): Promise<ApprovalView[]> {
  const names = await namesFor(db, rows.flatMap((row) => [row.recordedById, row.withdrawnById]))
  const files = new Map((rows.length > 0 ? await db.storedFile.findMany({ where: { id: { in: rows.map((row) => row.evidenceFileId) } }, select: { id: true, originalName: true, contentType: true, status: true } }) : []).map((file) => [file.id, file]))
  const actor = actorOf(context)
  return rows.map((row) => {
    const file = files.get(row.evidenceFileId)
    const live = row.withdrawnAt === null
    return {
      id: row.id,
      companyId: row.companyId,
      templateKind: row.templateKind as PpeTextKind,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      templateId: templateIdOf(row.templateKey, row.templateVersion),
      languages: [...row.languages],
      checkedBy: row.checkedBy,
      recordedAt: toUtcIso(row.recordedAt),
      recordedBy: names(row.recordedById),
      evidence: file ? { id: file.id, originalName: file.originalName, contentType: file.contentType, status: String(file.status) } : null,
      withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
      withdrawnBy: names(row.withdrawnById),
      withdrawReason: row.withdrawReason,
      live,
      version: row.version,
      mayWithdraw: live && mayWrite(actor, PPE_TEXTS_MANAGE, row.companyId),
    }
  })
}

const LABEL_SELECT = { id: true, code: true, revision: true, name: true, status: true, companyId: true, languages: true } as const satisfies Prisma.LabelTemplateSelect

export interface ListQuery {
  readonly kind?: PpeTextKind | undefined
  readonly q?: string | undefined
  /** The screen's company (mayRecord.company); default the session's. */
  readonly companyId?: string | undefined
}

/** GET /compliance/ppe-texts */
export async function listPpeTexts(request: FastifyRequest, query: ListQuery) {
  const context = officeOf(request)
  const actor = actorOf(context)
  return request.withClient(async (db) => {
    const rows = await db.ppeTextApproval.findMany({ where: { AND: [reach(context), query.kind ? { templateKind: query.kind } : {}] }, select: APPROVAL_SELECT, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 1000 })
    // The labels whose class warnings a consultant checks: the PPE garment labels in use or being drawn (a retired one only
    // while an approval names it), of every company and of the companies the reader reaches.
    const named = new Set(rows.filter((row) => row.templateKind === 'LABEL_WARNING').map((row) => `${row.templateKey}.${row.templateVersion}`))
    const labels = query.kind && query.kind !== 'LABEL_WARNING' ? [] : await db.labelTemplate.findMany({ where: { AND: [scopeWhere(actor, PPE_TEXTS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.LabelTemplateWhereInput, { kind: 'PPE_GARMENT' }] }, select: LABEL_SELECT, orderBy: [{ code: 'asc' }, { revision: 'asc' }, { id: 'asc' }], take: 500 })
    const shown = labels.filter((label) => label.status !== 'RETIRED' || named.has(`${label.code}.${label.revision}`))
    const templates = [
      ...(['DOC', 'USER_INFORMATION'] as const).filter((kind) => !query.kind || query.kind === kind).map((kind) => ({ kind, key: GENERATOR_TEMPLATES[kind].key, version: GENERATOR_TEMPLATES[kind].version, label: null })),
      ...shown.map((label) => ({ kind: 'LABEL_WARNING' as const, key: label.code, version: label.revision, label: { id: label.id, code: label.code, revision: label.revision, name: label.name, status: String(label.status), companyId: label.companyId, languages: [...label.languages] } })),
    ]
      .filter((template) => !query.q || `${template.key} ${template.label?.name ?? ''}`.toLowerCase().includes(query.q.toLowerCase()))
      .map((template) => {
        const own = rows.filter((row) => row.templateKind === template.kind && row.templateKey === template.key && row.templateVersion === template.version)
        const live = own.filter((row) => isLive(factsOf(row)))
        return {
          templateKind: template.kind,
          templateKey: template.key,
          templateVersion: template.version,
          templateId: templateIdOf(template.key, template.version),
          label: template.label,
          state: live.length > 0 ? ('APPROVED' as const) : own.length > 0 ? ('WITHDRAWN' as const) : ('NONE' as const),
          liveLanguages: [...new Set(live.flatMap((row) => row.languages))].sort(),
          approvals: own.length,
        }
      })
    const company = query.companyId ?? context.companyId ?? null
    return {
      templates,
      approvals: await approvalViews(db, context, rows),
      mayRecord: { company: company !== null && mayWrite(actor, PPE_TEXTS_MANAGE, company), everyCompany: mayWrite(actor, PPE_TEXTS_MANAGE, null) },
      asOf: toUtcIso(rulesClock().now()),
    }
  })
}

export interface AnnounceBody {
  readonly companyId?: string | null | undefined
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** POST /compliance/ppe-texts/evidence: the consultant's file, a file of the approval to come. */
export async function announceEvidence(caller: CommandCaller, body: AnnounceBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayManage(context, companyId)
  const approvalId = newId()
  const answer = await requestUpload(
    processFiles(),
    caller,
    { companyId, recordType: 'PpeTextApproval', recordId: approvalId, kind: 'DOCUMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
  // A repeat of the same Idempotency-Key answers the file announced first: its record is the approval id to use.
  return { approvalId: answer.file.recordId, ...answer }
}

export interface RecordBody {
  readonly approvalId: string
  readonly fileId: string
  readonly companyId?: string | null | undefined
  readonly templateKind: PpeTextKind
  readonly templateKey: string
  readonly templateVersion: number
  readonly languages: readonly string[]
  readonly checkedBy: string
}

/** POST /compliance/ppe-texts: record a PPE consultant's yes (asks a fresh code). */
export async function recordApproval(caller: CommandCaller, body: RecordBody, idempotencyKey: string | undefined, stepUp: () => void) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  const problems = recordProblems(body)
  if (problems.length > 0) throw new ValidationError('The approval is not valid.', problems)
  assertMayManage(context, companyId)
  const languages = normaliseLanguages(body.languages)
  const templateKey = body.templateKey.trim()
  // A label's class warnings: the label template exists (its code and revision), of the approval's company or every company's.
  const prepared = await caller.withClient(async (db) => {
    const file = await db.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, recordType: true, recordId: true, companyId: true, status: true } })
    if (!file || file.recordType !== 'PpeTextApproval' || file.recordId !== body.approvalId || file.status === 'DELETED') {
      throw new ValidationError('The approval is not valid.', [{ path: 'body/fileId', message: "Not this approval's file: announce the consultant's file first (POST /compliance/ppe-texts/evidence) and send it." }])
    }
    if (file.companyId !== companyId) throw new ValidationError('The approval is not valid.', [{ path: 'body/fileId', message: "The consultant's file was announced for another company: announce it again for this one." }])
    if (await db.ppeTextApproval.findUnique({ where: { id: body.approvalId }, select: { id: true } })) return { taken: true }
    if (body.templateKind === 'LABEL_WARNING') {
      const labels = await db.labelTemplate.findMany({ where: { code: templateKey, revision: body.templateVersion }, select: { id: true, companyId: true, kind: true } })
      const fits = labels.filter((label) => labelFitsApproval(label.companyId, companyId))
      if (fits.length === 0) {
        throw new ValidationError('The approval is not valid.', [
          { path: 'body/templateKey', message: labels.length === 0 ? `There is no label ${templateKey} revision ${body.templateVersion}.` : `Label ${templateKey} revision ${body.templateVersion} is another company's: record the yes for its company.` },
        ])
      }
    }
    return { taken: false }
  })
  if (prepared.taken) throw refused('RECORDED', 'This approval is recorded already.')
  stepUp()
  const confirmed = await completeUpload(processFiles(), caller, body.fileId, idempotencyKey, { viaModule: true })
  if (confirmed.status !== 'AVAILABLE') throw new ConflictError(`The consultant's file did not arrive as announced (${confirmed.quarantineReason ?? confirmed.status}): announce it again and send the file.`)
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.ppeTexts.record', idempotencyKey, input: { ...body, languages, templateKey } },
        async (tools) => {
          const { tx, now, audit, emit } = tools
          if (companyId && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
          const row = await tx.ppeTextApproval.create({
            data: {
              id: body.approvalId,
              companyId,
              templateKind: body.templateKind,
              templateKey,
              templateVersion: body.templateVersion,
              languages,
              checkedBy: normaliseCheckedBy(body.checkedBy),
              recordedById: context.actorId,
              recordedAt: now,
              evidenceFileId: body.fileId,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: APPROVAL_SELECT,
          })
          await retainFilesInCommand(tools, [body.fileId], addYears(now, EVIDENCE_YEARS), EVIDENCE_WHY)
          audit({ recordType: 'PpeTextApproval', recordId: row.id, companyId, after: { templateKind: row.templateKind, templateKey, templateVersion: row.templateVersion, languages, checkedBy: row.checkedBy, evidenceFileId: row.evidenceFileId } })
          emit({ type: 'compliance_ppe_texts.approval_changed', subject: row.id, companyId, payload: { approvalId: row.id, companyId, templateKind: body.templateKind, templateKey, templateVersion: row.templateVersion, languages, change: 'RECORDED' } })
          return row.id
        },
        settings(),
      ),
    { taken: 'This approval is recorded already.' },
  )
  return { approval: await readOne(caller, context, result) }
}

async function readOne(caller: CommandCaller, context: OfficeContext, approvalId: string): Promise<ApprovalView> {
  return caller.withClient(async (db) => {
    const row = await db.ppeTextApproval.findFirst({ where: { AND: [reach(context), { id: approvalId }] }, select: APPROVAL_SELECT })
    if (!row) throw new NotFoundError('There is no such approval.')
    return (await approvalViews(db, context, [row]))[0]!
  })
}

/** POST /compliance/ppe-texts/:approvalId/withdraw: once, with a reason; the texts issued meanwhile stay issued. */
export async function withdrawApproval(caller: CommandCaller, approvalId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const problems = withdrawProblems(body.reason)
  if (problems.length > 0) throw new ValidationError('The withdrawal is not valid.', problems)
  const known = await caller.withClient((db) => db.ppeTextApproval.findFirst({ where: { AND: [reach(context), { id: approvalId }] }, select: APPROVAL_SELECT }))
  if (!known) throw new NotFoundError('There is no such approval.')
  assertMayManage(context, known.companyId)
  if (known.withdrawnAt) throw refused('WITHDRAWN', `This approval was withdrawn on ${toUtcIso(known.withdrawnAt).slice(0, 10)}: a withdrawal is written once.`)
  const reason = body.reason.trim()
  await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.ppeTexts.withdraw', idempotencyKey, input: { approvalId, ...body }, record: { type: 'PpeTextApproval', id: approvalId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const row = await tx.ppeTextApproval.update({ where: { id: approvalId }, data: { withdrawnAt: now, withdrawnById: context.actorId, withdrawReason: reason }, select: APPROVAL_SELECT })
        audit({ recordType: 'PpeTextApproval', recordId: approvalId, companyId: row.companyId, reason, before: { withdrawnAt: null }, after: { withdrawnAt: toUtcIso(now) } })
        emit({ type: 'compliance_ppe_texts.approval_changed', subject: approvalId, companyId: row.companyId, payload: { approvalId, companyId: row.companyId, templateKind: row.templateKind as PpeTextKind, templateKey: row.templateKey, templateVersion: row.templateVersion, languages: [...row.languages], change: 'WITHDRAWN' } })
        return approvalId
      },
      settings(),
    ),
  )
  return { approval: await readOne(caller, context, approvalId) }
}
