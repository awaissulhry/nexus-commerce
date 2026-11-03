import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_RISK_MANAGE, SAFETY_RISK_SIGN } from '@nexus/factory-domain/safety/risk/permissions'
import {
  completion,
  dvrSignatureId,
  dvrSignatureKey,
  farRefusal,
  freezeRefusal,
  holdersOf,
  personKeyOf,
  signatureRefusal,
  signersFor,
  versionProblems,
  withdrawRefusal,
  type DvrAuthorKind,
  type DvrSignerRole,
  type DvrVersionStatus,
  type RiskRefusal,
} from '@nexus/factory-domain/safety/risk/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { FilesRuntime } from '../../../platform/files/service'
import { assertMayAt, assertMayWriteAt, assertVersion, dateOf, dayOf, officeOf, problemsError, refuse, todayOf } from '../organisation/access'
import { writableAssessment } from './assessments'
import { keepSeal } from './seal'
import { isHolder, meOf, organisationOf, personsOfMe, readAssessment, readVersion, RECORD_SIGNATURE, romeDay, signedPersons, versionViews, type VersionRow } from './store'

/**
 * The versions of a risk assessment and their signatures (B-W2b-122; QHS-230; design plant.risk pop-ups New DVR version and
 * Sign version, the record's Versions tab), office only, each write one command with an Idempotency-Key:
 *
 *   POST /safety/risk/assessments/:id/versions      freeze a version (safety.risk.manage): the consultant's PDF, uploaded as
 *                                                   a file of the assessment, frozen with its SHA-256 (the file's) and the
 *                                                   time; numbered above every earlier one; its signers from the safety
 *                                                   organisation in force (the employer always, the RSPP, the RLS or RLST and
 *                                                   the doctor where appointed; a person holding two roles signs once)
 *   POST /safety/risk/versions/:id/withdraw         a mistake, before it is signed, with the reason (safety.risk.manage)
 *   POST /safety/risk/versions/:id/sign             the signer's own signature in the office (safety.risk.sign, a fresh code
 *                                                   after every other check): they hold the role, type their own name, sign
 *                                                   today; nobody signs a version twice
 *   POST /safety/risk/versions/:id/signatures       a signed paper recorded (safety.risk.manage): the name and day on it, its
 *                                                   scan uploaded first as a file of the signature (the id the version shows)
 *
 * When the last listed signer signs, the same command makes the version SIGNED with its certain date (the day of the last
 * signature); the seal (GeneratedDocument DVR_FROZEN, ./seal.ts) is kept right after, in its own command (a file store that
 * does not answer leaves it signed and unsealed: POST …/seal keeps it later). A frozen version never changes: a change is a
 * new version. The badge-and-PIN signature (FLOOR_PIN) is read, not written here (see the step's notes). factory-db's
 * guards hold the same rules for every login; these answer first, in words.
 */

type Reader = FactoryClient | CommandTx

const MANAGE_WORDS = 'The risk assessments of this site are kept by a role that keeps them (safety.risk.manage).'
const SIGN_WORDS = 'You sign a version in the office for a safety role you hold (safety.risk.sign).'

const refuseWith = (refusal: RiskRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

async function versionAnswer(client: Reader, context: OfficeContext, versionId: string, today: BusinessDate) {
  const row = (await readVersion(client, versionId))!
  return (await versionViews(client, context, [row], today))[0]!
}

export interface FreezeBody {
  readonly fileId: string
  readonly label: string
  readonly effectiveOn: BusinessDate
  readonly authorKind: DvrAuthorKind
  readonly authorName: string
  readonly changeSummary?: string | null | undefined
}

/** POST /safety/risk/assessments/:assessmentId/versions. */
export async function freezeVersion(caller: CommandCaller, assessmentId: string, body: FreezeBody, idempotencyKey?: string) {
  await writableAssessment(caller, assessmentId)
  const problems = versionProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The version is not complete.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.freezeDvrVersion', idempotencyKey, input: { assessmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const context = tools.context as OfficeContext
    // One version at a time per assessment.
    await tx.$queryRaw`SELECT "id" FROM "RiskAssessment" WHERE "id" = ${assessmentId}::uuid FOR UPDATE`
    const assessment = (await readAssessment(tx, assessmentId))!
    const versions = await tx.riskAssessmentVersion.findMany({ where: { assessmentId }, select: { id: true, versionNo: true, label: true, status: true, sha256: true } })
    const file = isUuid(body.fileId)
      ? await tx.storedFile.findFirst({ where: { id: body.fileId, recordType: 'RiskAssessment', recordId: assessmentId, companyId: assessment.companyId, status: { not: 'DELETED' } }, select: { status: true, contentType: true, sha256: true } })
      : null
    const sha256 = file?.sha256?.toLowerCase() ?? null
    const organisation = await organisationOf(tx, assessment.companyId)
    const plan = signersFor(organisation.appointments, assessment.siteId, today)
    refuseWith(
      freezeRefusal({
        archived: assessment.status !== 'ACTIVE',
        waiting: versions.find((version) => version.status === 'AWAITING_SIGNATURES') ?? null,
        file: file && sha256 ? { status: file.status, contentType: file.contentType } : null,
        frozenAlready: versions.find((version) => version.status !== 'WITHDRAWN' && version.sha256 === sha256) ?? null,
        missingEmployer: plan.missingEmployer,
      }),
    )
    refuseWith(farRefusal(body.effectiveOn, today, 'effectiveOn'))
    const versionNo = Math.max(0, ...versions.map((version) => version.versionNo)) + 1
    const signersRequired = plan.signers.map((signer) => signer.role)
    const label = body.label.trim()
    await tx.riskAssessmentVersion.create({
      data: {
        id,
        companyId: assessment.companyId,
        siteId: assessment.siteId,
        assessmentId,
        versionNo,
        label,
        effectiveOn: dateOf(body.effectiveOn),
        authorKind: body.authorKind,
        authorName: body.authorName.trim(),
        changeSummary: body.changeSummary?.trim() || null,
        fileId: body.fileId,
        sha256: sha256!,
        frozenAt: now,
        frozenById: context.actorId,
        signersRequired,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'safety.freezeDvrVersion',
      recordType: 'RiskAssessment',
      recordId: assessmentId,
      companyId: assessment.companyId,
      siteId: assessment.siteId,
      after: { versionId: id, versionNo, label, effectiveOn: body.effectiveOn, authorKind: body.authorKind, fileId: body.fileId, sha256, frozenAt: now.toISOString(), signersRequired, sameAs: plan.sameAs.map((entry) => `${entry.role}=${entry.as}`) },
    })
    tools.emit({ type: 'risk_assessment_version.changed', subject: assessmentId, companyId: assessment.companyId, siteId: assessment.siteId, payload: { assessmentId, versionId: id, versionNo, change: 'FROZEN', certainDateOn: null } })
    return { version: await versionAnswer(tx, context, id, today) }
  })
  return { ...result, replayed }
}

/** The version the caller may act on (404 when it may not read it, 403 in words when it may not act). */
async function actable(caller: CommandCaller, versionId: string, permission: typeof SAFETY_RISK_MANAGE | typeof SAFETY_RISK_SIGN): Promise<VersionRow> {
  const context = officeOf(caller)
  const row = isUuid(versionId) ? await caller.withClient((client) => readVersion(client, versionId)) : null
  if (!row) throw new NotFoundError('Version not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Version')
  assertMayWriteAt(context, permission, row, permission === SAFETY_RISK_SIGN ? SIGN_WORDS : MANAGE_WORDS)
  return row
}

const lockVersion = async (tools: Pick<CommandTools, 'tx'>, versionId: string): Promise<VersionRow> => {
  await tools.tx.$queryRaw`SELECT "id" FROM "RiskAssessmentVersion" WHERE "id" = ${versionId}::uuid FOR UPDATE`
  return (await readVersion(tools.tx, versionId))!
}

/** POST /safety/risk/versions/:versionId/withdraw: before it is signed, with the reason. */
export async function withdrawVersion(caller: CommandCaller, versionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await actable(caller, versionId, SAFETY_RISK_MANAGE)
  const { result } = await command(caller, { name: 'safety.withdrawDvrVersion', idempotencyKey, input: { versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockVersion(tools, versionId)
    assertVersion('version', row.version, body.version)
    refuseWith(withdrawRefusal(row.status as DvrVersionStatus))
    const reason = body.reason.trim()
    await tx.riskAssessmentVersion.update({ where: { id: versionId }, data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.withdrawDvrVersion', recordType: 'RiskAssessmentVersion', recordId: versionId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'WITHDRAWN' }, reason })
    tools.emit({ type: 'risk_assessment_version.changed', subject: row.assessmentId, companyId: row.companyId, siteId: row.siteId, payload: { assessmentId: row.assessmentId, versionId, versionNo: row.versionNo, change: 'WITHDRAWN', certainDateOn: null } })
    return { version: await versionAnswer(tx, tools.context as OfficeContext, versionId, todayOf(now)) }
  })
  return result
}

export interface SignatureBody {
  readonly role: DvrSignerRole
  readonly signerName: string
  readonly appointmentId?: string | undefined
  /** PAPER only: the day written on the paper. */
  readonly signedOn?: BusinessDate | undefined
}

/** Why this signature cannot be recorded now (null: it can), with the appointment it is given under. */
async function signatureCheck(client: Reader, context: OfficeContext, row: VersionRow, method: 'OFFICE' | 'PAPER', body: SignatureBody, now: Date) {
  const today = todayOf(now)
  const signedOn = method === 'OFFICE' ? today : (body.signedOn ?? today)
  const organisation = await organisationOf(client, row.companyId)
  const holders = holdersOf(organisation.appointments, body.role, row.siteId, signedOn)
  const holder = (body.appointmentId ? holders.find((candidate) => candidate.id === body.appointmentId) : holders[0]) ?? null
  const me = method === 'OFFICE' ? await meOf(client, context) : null
  const signatureId = dvrSignatureId(row.id, body.role)
  const scanOnFile = method === 'PAPER' ? (await client.storedFile.count({ where: { recordType: RECORD_SIGNATURE, recordId: signatureId, companyId: row.companyId, status: 'AVAILABLE' } })) > 0 : false
  const refusal = signatureRefusal({
    status: row.status as DvrVersionStatus,
    signersRequired: row.signersRequired as DvrSignerRole[],
    signed: await signedPersons(client, row.signatures, organisation),
    role: body.role,
    method,
    signerName: body.signerName,
    signedOn,
    today,
    frozenOn: romeDay(row.frozenAt),
    appointment: holder ? { name: holder.name, persons: [personKeyOf(holder), ...(me ? personsOfMe(me) : [])] } : null,
    isTheSigner: me !== null && holder !== null && isHolder(me, holder, organisation),
    scanOnFile,
  })
  return { refusal, holder, signedOn, signatureId, scanOnFile }
}

export interface CollectOptions {
  readonly idempotencyKey?: string | undefined
  /** OFFICE: the fresh step-up code, asked after every other check. */
  readonly stepUp?: () => void | Promise<void>
  /** The files runtime for the seal kept right after the last signature. */
  readonly files: FilesRuntime
}

async function collect(request: FastifyRequest, versionId: string, method: 'OFFICE' | 'PAPER', body: SignatureBody, options: CollectOptions) {
  const context = officeOf(request)
  const row = await actable(request, versionId, method === 'OFFICE' ? SAFETY_RISK_SIGN : SAFETY_RISK_MANAGE)
  const first = await request.withClient((client) => signatureCheck(client, context, row, method, body, new Date()))
  refuseWith(first.refusal)
  if (method === 'OFFICE') await options.stepUp?.()
  const name = method === 'OFFICE' ? 'safety.signDvr' : 'safety.recordDvrPaperSignature'
  const { result, replayed } = await command(request, { name, idempotencyKey: options.idempotencyKey, input: { versionId, method, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await lockVersion(tools, versionId)
    const check = await signatureCheck(tx, tools.context as OfficeContext, locked, method, body, now)
    refuseWith(check.refusal)
    const holder = check.holder!
    const signerName = body.signerName.trim()
    const actorId = (tools.context as OfficeContext).actorId
    await tx.riskAssessmentSignature.create({
      data: {
        id: check.signatureId,
        companyId: locked.companyId,
        siteId: locked.siteId,
        versionId,
        key: dvrSignatureKey(versionId, body.role),
        role: body.role,
        appointmentId: holder.id,
        signerName,
        signedOn: dateOf(check.signedOn),
        signedAt: now,
        method,
        signedById: actorId,
        signatureSha256: locked.sha256,
        createdAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    const done = completion(locked.signersRequired as DvrSignerRole[], [...locked.signatures.map((signature) => ({ role: signature.role as DvrSignerRole, signedOn: dayOf(signature.signedOn) })), { role: body.role, signedOn: check.signedOn }])
    const scope = { companyId: locked.companyId, siteId: locked.siteId }
    tools.audit({
      action: name,
      recordType: 'RiskAssessmentVersion',
      recordId: versionId,
      ...scope,
      after: { signatureId: check.signatureId, role: body.role, method, signerName, signedOn: check.signedOn, appointmentId: holder.id, signatureSha256: locked.sha256, ...(method === 'PAPER' ? { scanOnFile: check.scanOnFile } : {}) },
    })
    tools.emit({ type: 'risk_signature.collected', subject: locked.assessmentId, ...scope, payload: { assessmentId: locked.assessmentId, versionId, role: body.role, method, complete: done.complete } })
    if (done.complete) {
      await tx.riskAssessmentVersion.update({ where: { id: versionId }, data: { status: 'SIGNED', certainDateOn: dateOf(done.certainDateOn!), signedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'safety.dvrSigned', recordType: 'RiskAssessmentVersion', recordId: versionId, ...scope, before: { status: 'AWAITING_SIGNATURES' }, after: { status: 'SIGNED', certainDateOn: done.certainDateOn } })
      tools.emit({ type: 'risk_assessment_version.changed', subject: locked.assessmentId, ...scope, payload: { assessmentId: locked.assessmentId, versionId, versionNo: locked.versionNo, change: 'SIGNED', certainDateOn: done.certainDateOn } })
    }
    return { complete: done.complete }
  })
  let sealed = false
  if (result.complete) {
    const kept = await request.withClient((client) => client.generatedDocument.count({ where: { recordType: 'RiskAssessmentVersion', recordId: versionId, kind: 'DVR_FROZEN' } }))
    sealed = kept > 0
    if (!sealed && !replayed) {
      // The seal in its own command: a file store that does not answer leaves the version signed and unsealed (POST …/seal).
      try {
        await keepSeal(options.files, request, versionId, { language: 'it', checked: true })
        sealed = true
      } catch (error) {
        request.log.warn({ versionId, error: error instanceof Error ? error.name : 'unknown' }, 'safety: the DVR seal was not kept; POST /safety/risk/versions/:versionId/seal keeps it')
      }
    }
  }
  return { version: await request.withClient((client) => versionAnswer(client, context, versionId, todayOf(new Date()))), complete: result.complete, sealed, replayed }
}

/** POST /safety/risk/versions/:versionId/sign: the signer's own signature in the office (a fresh code). */
export const signVersion = (request: FastifyRequest, versionId: string, body: Omit<SignatureBody, 'signedOn'>, options: CollectOptions) => collect(request, versionId, 'OFFICE', body, options)

/** POST /safety/risk/versions/:versionId/signatures: a signed paper, with its scan on file. */
export const recordPaperSignature = (request: FastifyRequest, versionId: string, body: SignatureBody & { readonly signedOn: BusinessDate }, options: CollectOptions) => collect(request, versionId, 'PAPER', body, options)

